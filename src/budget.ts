import type { Office, OfficeId } from './domain.js';
import { subtract, sum, type Money } from './money.js';
import type { RefillStore } from './refillStore.js';
import { localMonth } from './time.js';

/**
 * Budget check per office per (office-local) calendar month.
 *
 * Spending is DERIVED from refills rather than kept as a separate running total:
 *  - a COMMITTED refill reserves the office's estimate (in the month it was committed),
 *  - a purchased refill counts its real receipt amount (in the month it was purchased),
 *  - an abandoned commitment simply stops being COMMITTED, so its reservation disappears.
 * One source of truth → reservation/settle/release can never drift out of sync.
 */
export class Budget {
  constructor(
    private readonly offices: Record<OfficeId, Office>,
    private readonly store: RefillStore,
  ) {}

  used(officeId: OfficeId, month: string): Money {
    const office = this.offices[officeId];
    const amounts: Money[] = [];
    for (const r of this.store.all()) {
      if (r.officeId !== officeId) continue;
      if (r.purchase) {
        if (localMonth(r.purchase.purchasedAt, office.timeZone) === month) amounts.push(r.purchase.amount);
      } else if (r.state === 'COMMITTED' && r.committedAt) {
        if (localMonth(r.committedAt, office.timeZone) === month) amounts.push(office.estimatedRefill);
      }
    }
    return sum(amounts, office.currency);
  }

  remaining(officeId: OfficeId, at: Date): Money {
    const office = this.offices[officeId];
    return subtract(office.monthlyBudget, this.used(officeId, localMonth(at, office.timeZone)));
  }

  /** Can the office afford one more typical refill right now? */
  canAffordEstimate(officeId: OfficeId, at: Date): boolean {
    return this.remaining(officeId, at).minor >= this.offices[officeId].estimatedRefill.minor;
  }
}
