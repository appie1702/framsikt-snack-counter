import { describe, expect, it } from 'vitest';
import { add, money, ofMinor } from '../src/money.js';
import { monthlyReport } from '../src/report.js';
import { completeRefill, systemWithVolunteers } from './helpers.js';

describe('money', () => {
  it('uses integer minor units, so 0.10 + 0.20 is exactly 0.30', () => {
    expect(add(money(0.1, 'NOK'), money(0.2, 'NOK'))).toEqual(money(0.3, 'NOK'));
  });
  it('refuses to add NOK to INR', () => {
    expect(() => add(money(1, 'NOK'), money(1, 'INR'))).toThrow('Currency mismatch');
  });
  it('refuses fractional minor units', () => {
    expect(() => ofMinor(10.5, 'NOK')).toThrow();
  });
});

describe('budget check', () => {
  it('reserves an estimate on commit and replaces it with the real amount on purchase', () => {
    const sys = systemWithVolunteers();
    const r = sys.service.reportEmpty('OSLO', 'x');
    sys.service.accept(r.id, r.offeredTo!);
    expect(sys.service.budget.remaining('OSLO', sys.clock.now())).toEqual(money(5200, 'NOK'));
    sys.service.recordPurchase(r.id, r.offeredTo ?? sys.store.get(r.id)!.committedBy!, { amount: money(1150, 'NOK'), receiptImage: 'a.jpg' });
    expect(sys.service.budget.remaining('OSLO', sys.clock.now())).toEqual(money(4850, 'NOK'));
  });

  it('needs coordinator approval once the remaining budget cannot cover a typical refill', () => {
    const sys = systemWithVolunteers();
    for (let i = 0; i < 7; i++) completeRefill(sys, 'OSLO', 800); // 5600 of 6000 used
    const r = sys.service.reportEmpty('OSLO', 'x');
    expect(r.state).toBe('AWAITING_BUDGET_APPROVAL');
    expect(r.offeredTo).toBeUndefined();
    expect(sys.chat.dmsTo('oslo-coordinator').at(-1)).toContain('400.00 NOK');

    expect(sys.service.approveOverBudget(r.id, 'kari').ok).toBe(false); // not the coordinator
    const approved = sys.service.approveOverBudget(r.id, 'oslo-coordinator');
    expect(approved.ok && approved.value.state).toBe('OFFERED');
  });

  it('flags (but records) a purchase that takes the office over budget', () => {
    const sys = systemWithVolunteers();
    for (let i = 0; i < 7; i++) completeRefill(sys, 'OSLO', 800);
    const r = sys.service.reportEmpty('OSLO', 'x');
    const approved = sys.service.approveOverBudget(r.id, 'oslo-coordinator');
    const who = approved.ok ? approved.value.offeredTo! : '';
    sys.service.accept(r.id, who);
    sys.service.recordPurchase(r.id, who, { amount: money(900, 'NOK'), receiptImage: 'a.jpg' });
    expect(sys.store.get(r.id)!.overBudget).toBe(true);
    expect(sys.service.budget.remaining('OSLO', sys.clock.now())).toEqual(money(-500, 'NOK'));
    expect(sys.chat.dmsTo('oslo-coordinator').at(-1)).toContain('over its monthly snack budget');
  });

  it('rejects a receipt in the wrong currency for the office', () => {
    const sys = systemWithVolunteers();
    const r = sys.service.reportEmpty('OSLO', 'x');
    sys.service.accept(r.id, r.offeredTo!);
    const res = sys.service.recordPurchase(r.id, r.offeredTo ?? sys.store.get(r.id)!.committedBy!, { amount: money(500, 'INR'), receiptImage: 'a.jpg' });
    expect(res.ok).toBe(false);
  });

  it("uses each office's own time zone for the month boundary", () => {
    // 30 Nov 19:00 UTC is already 1 Dec 00:30 in Bengaluru, but still 30 Nov 20:00 in Oslo
    const sys = systemWithVolunteers({ now: new Date('2026-11-30T19:00:00Z') });
    completeRefill(sys, 'BLR', 2000);
    completeRefill(sys, 'OSLO', 1000);

    const nov = monthlyReport('2026-11', sys.offices, sys.store.all(), sys.fx);
    const dec = monthlyReport('2026-12', sys.offices, sys.store.all(), sys.fx);
    expect(nov.offices.find((o) => o.officeId === 'BLR')!.spent).toEqual(money(0, 'INR'));
    expect(dec.offices.find((o) => o.officeId === 'BLR')!.spent).toEqual(money(2000, 'INR'));
    expect(nov.offices.find((o) => o.officeId === 'OSLO')!.spent).toEqual(money(1000, 'NOK'));
  });
});

describe('monthly report across both currencies', () => {
  it('reports each office in its own currency and a correct grand total in NOK', () => {
    const sys = systemWithVolunteers();
    completeRefill(sys, 'OSLO', 845.5);
    completeRefill(sys, 'OSLO', 1200);
    completeRefill(sys, 'BLR', 2000);
    completeRefill(sys, 'BLR', 2999.99);

    const report = monthlyReport('2026-11', sys.offices, sys.store.all(), sys.fx, 'NOK');
    const oslo = report.offices.find((o) => o.officeId === 'OSLO')!;
    const blr = report.offices.find((o) => o.officeId === 'BLR')!;

    expect(oslo.spent).toEqual(money(2045.5, 'NOK'));
    expect(oslo.remaining).toEqual(money(3954.5, 'NOK'));
    expect(blr.spent).toEqual(money(4999.99, 'INR'));
    expect(blr.remaining).toEqual(money(10000.01, 'INR'));
    // 4999.99 INR × 0.125 = 624.99875 → 625.00 NOK (each purchase rounded at its own rate)
    expect(blr.spentInReportCurrency).toEqual(money(625, 'NOK'));
    expect(report.total).toEqual(money(2670.5, 'NOK'));
    expect(report.fxUsed).toHaveLength(2);
    expect(oslo.refills).toBe(2);
    expect(oslo.outstandingClaims).toBe(2);
  });

  it('can be produced in INR too', () => {
    const sys = systemWithVolunteers();
    completeRefill(sys, 'OSLO', 100);
    completeRefill(sys, 'BLR', 800);
    const report = monthlyReport('2026-11', sys.offices, sys.store.all(), sys.fx, 'INR');
    expect(report.total).toEqual(money(1600, 'INR')); // 100 NOK = 800 INR, + 800 INR
  });
});
