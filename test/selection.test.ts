import { describe, expect, it } from 'vitest';
import { money } from '../src/money.js';
import { completeRefill, systemWithVolunteers } from './helpers.js';

describe('choosing who buys', () => {
  it('prefers people with no money outstanding, then fewest recent refills', () => {
    const sys = systemWithVolunteers();
    // Everyone equal → deterministic tiebreak by id: kari < nils < ola
    const first = completeRefill(sys, 'OSLO', 500);
    expect(first.who).toBe('kari');

    // kari is now waiting for 500 NOK → she is not asked next
    const second = completeRefill(sys, 'OSLO', 500);
    expect(second.who).toBe('nils');

    // kari gets reimbursed: 0 outstanding but 1 refill; ola has 0 outstanding and 0 refills → ola first
    const kariClaim = sys.store.get(first.id)!.claim!.hrClaimId!;
    sys.hr.decide(kariClaim, 'APPROVED');
    sys.service.syncClaims();
    const third = completeRefill(sys, 'OSLO', 500);
    expect(third.who).toBe('ola');

    // Now kari (reimbursed) beats nils and ola, who are both still owed money
    const fourth = sys.service.reportEmpty('OSLO', 'x');
    expect(fourth.offeredTo).toBe('kari');
  });

  it('never asks someone who is not at the office today (home, holiday, inactive)', () => {
    const sys = systemWithVolunteers();
    sys.roster.checkOut('kari', 'OSLO', sys.clock.now()); // working from home
    sys.roster.setActive('nils', false); // left the volunteer group
    const r = sys.service.reportEmpty('OSLO', 'x');
    expect(r.offeredTo).toBe('ola');
  });

  it('a visitor from the other office can refill, charged to the visited office in its currency', () => {
    const sys = systemWithVolunteers();
    sys.roster.checkOut('priya', 'BLR', sys.clock.now());
    sys.roster.checkOut('arjun', 'BLR', sys.clock.now());
    sys.roster.checkIn('ola', 'BLR', sys.clock.now()); // Oslo employee visiting Bengaluru

    const r = sys.service.reportEmpty('BLR', 'x');
    expect(r.offeredTo).toBe('ola');
    sys.service.accept(r.id, 'ola');
    const res = sys.service.recordPurchase(r.id, 'ola', { amount: money(1800, 'INR'), receiptImage: 'blr.jpg' });
    expect(res.ok).toBe(true);

    // HR gets INR; it converts to ola's NOK payroll itself
    expect([...sys.hr.claims.values()][0]).toMatchObject({ employeeId: 'ola', currency: 'INR', amount: '1800.00' });
    expect(sys.service.budget.remaining('BLR', sys.clock.now())).toEqual(money(13200, 'INR'));
    expect(sys.service.budget.remaining('OSLO', sys.clock.now())).toEqual(money(6000, 'NOK'));
  });

  it("compares a visitor's outstanding money across currencies", () => {
    const sys = systemWithVolunteers();
    sys.roster.checkIn('kari', 'BLR', sys.clock.now()); // kari is in Bengaluru today
    sys.roster.checkOut('kari', 'OSLO', sys.clock.now());
    sys.roster.checkOut('priya', 'BLR', sys.clock.now());
    // arjun pays 4000 INR (≈ 500 NOK) and is waiting for it
    const r = sys.service.reportEmpty('BLR', 'x');
    expect(r.offeredTo).toBe('arjun');
    sys.service.accept(r.id, 'arjun');
    sys.service.recordPurchase(r.id, 'arjun', { amount: money(4000, 'INR'), receiptImage: 'a.jpg' });
    expect(sys.service.statsFor('arjun').outstandingMinor).toBe(50000); // 500.00 NOK in øre

    // next BLR refill → kari (nothing outstanding) is asked before arjun
    expect(sys.service.reportEmpty('BLR', 'x').offeredTo).toBe('kari');
  });
});
