import { OUTSTANDING_STATES, type EmployeeId, type Office, type OfficeId, type Refill } from './domain.js';
import { ofMinor, subtract, sum, type Currency, type Money } from './money.js';
import type { FxRates } from './ports.js';
import { HOUR, localMonth } from './time.js';

export interface OfficeMonth {
  officeId: OfficeId;
  budget: Money;
  spent: Money;
  remaining: Money;
  overBudget: boolean;
  refills: number;
  /** Average hours from "reported empty" to "restocked": the box-empty problem, measured. */
  avgHoursEmpty: number | null;
  refillsByVolunteer: Record<EmployeeId, number>;
  outstandingClaims: number;
  tags: Record<string, number>;
  spentInReportCurrency: Money;
}

export interface MonthlyReport {
  month: string;
  reportCurrency: Currency;
  offices: OfficeMonth[];
  total: Money;
  /** Every rate used, so the numbers can be audited later. */
  fxUsed: { date: string; from: Currency; to: Currency; rate: number }[];
}

/**
 * One monthly report across both offices. Each office is reported in its own currency
 * (matches its budget); the grand total converts each purchase at the rate on its purchase date.
 */
export function monthlyReport(
  month: string,
  offices: Record<OfficeId, Office>,
  refills: Refill[],
  fx: FxRates,
  reportCurrency: Currency = 'NOK',
): MonthlyReport {
  const fxUsed: MonthlyReport['fxUsed'] = [];
  const officeRows: OfficeMonth[] = [];

  for (const office of Object.values(offices)) {
    const purchased = refills.filter(
      (r) => r.officeId === office.id && r.purchase && localMonth(r.purchase.purchasedAt, office.timeZone) === month,
    );
    const spent = sum(purchased.map((r) => r.purchase!.amount), office.currency);

    let convertedMinor = 0;
    for (const r of purchased) {
      const { amount, purchasedAt } = r.purchase!;
      const rate = fx.rate(amount.currency, reportCurrency, purchasedAt);
      if (amount.currency !== reportCurrency) {
        fxUsed.push({ date: purchasedAt.toISOString().slice(0, 10), from: amount.currency, to: reportCurrency, rate });
      }
      convertedMinor += Math.round(amount.minor * rate);
    }

    const byVolunteer: Record<EmployeeId, number> = {};
    const tags: Record<string, number> = {};
    for (const r of purchased) {
      byVolunteer[r.committedBy!] = (byVolunteer[r.committedBy!] ?? 0) + 1;
      for (const t of r.purchase!.tags) tags[t] = (tags[t] ?? 0) + 1;
    }
    const emptyHours = purchased.map((r) => (r.purchase!.purchasedAt.getTime() - r.reportedAt.getTime()) / HOUR);

    const remaining = subtract(office.monthlyBudget, spent);
    officeRows.push({
      officeId: office.id,
      budget: office.monthlyBudget,
      spent,
      remaining,
      overBudget: remaining.minor < 0,
      refills: purchased.length,
      avgHoursEmpty: emptyHours.length ? Math.round((emptyHours.reduce((a, b) => a + b, 0) / emptyHours.length) * 10) / 10 : null,
      refillsByVolunteer: byVolunteer,
      outstandingClaims: purchased.filter((r) => OUTSTANDING_STATES.has(r.state)).length,
      tags,
      spentInReportCurrency: ofMinor(convertedMinor, reportCurrency),
    });
  }

  return {
    month,
    reportCurrency,
    offices: officeRows,
    total: sum(officeRows.map((o) => o.spentInReportCurrency), reportCurrency),
    fxUsed,
  };
}
