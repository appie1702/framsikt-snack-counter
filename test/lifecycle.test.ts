import { describe, expect, it } from 'vitest';
import { money } from '../src/money.js';
import { ConcurrencyError } from '../src/refillStore.js';
import { HOUR } from '../src/time.js';
import { systemWithVolunteers } from './helpers.js';

describe('refill lifecycle: empty → reimbursed', () => {
  it('moves through every state and tells the right people', () => {
    const sys = systemWithVolunteers();
    const r = sys.service.reportEmpty('OSLO', 'any-employee');
    expect(r.state).toBe('OFFERED');
    const volunteer = r.offeredTo!;
    expect(sys.chat.dmsTo(volunteer).at(-1)).toContain('snack box is empty');

    expect(sys.service.accept(r.id, volunteer).ok).toBe(true);
    expect(sys.store.get(r.id)!.state).toBe('COMMITTED');
    expect(sys.chat.channel.at(-1)!.text).toContain('No need for anyone else to buy');

    const bought = sys.service.recordPurchase(r.id, volunteer, { amount: money(845.5, 'NOK'), receiptImage: 'img.jpg', tags: ['chips'] });
    expect(bought.ok && bought.value.state).toBe('CLAIM_SUBMITTED');

    const claim = [...sys.hr.claims.values()][0]!;
    expect(claim).toMatchObject({ employeeId: volunteer, amount: '845.50', currency: 'NOK', receiptImage: 'img.jpg', reference: r.id });

    sys.hr.decide(bought.ok ? bought.value.claim!.hrClaimId! : '', 'APPROVED');
    sys.service.syncClaims();
    expect(sys.store.get(r.id)!.state).toBe('REIMBURSED');
    expect(sys.chat.dmsTo(volunteer).at(-1)).toContain('approved');
  });

  it('a second "box is empty" report does not open a second refill', () => {
    const sys = systemWithVolunteers();
    const a = sys.service.reportEmpty('OSLO', 'x');
    const b = sys.service.reportEmpty('OSLO', 'y');
    expect(b.id).toBe(a.id);
    expect(sys.store.all()).toHaveLength(1);
  });

  it('offices are independent: Oslo and Bengaluru can each have one active refill', () => {
    const sys = systemWithVolunteers();
    const oslo = sys.service.reportEmpty('OSLO', 'x');
    const blr = sys.service.reportEmpty('BLR', 'y');
    expect(oslo.id).not.toBe(blr.id);
    expect(blr.offeredTo).toMatch(/priya|arjun/);
  });

  it('a new refill can open while the previous claim is still waiting at HR', () => {
    const sys = systemWithVolunteers();
    const first = sys.service.reportEmpty('OSLO', 'x');
    sys.service.accept(first.id, first.offeredTo!);
    sys.service.recordPurchase(first.id, first.offeredTo!, { amount: money(500, 'NOK'), receiptImage: 'a.jpg' });
    const second = sys.service.reportEmpty('OSLO', 'x');
    expect(second.id).not.toBe(first.id);
  });
});

describe('two people cannot both commit to the same refill', () => {
  it('in broadcast mode the first accept wins and the second is told who has it', () => {
    const sys = systemWithVolunteers({ config: { maxDirectOffers: 0 } });
    const r = sys.service.reportEmpty('OSLO', 'x');
    expect(r.state).toBe('BROADCAST');

    expect(sys.service.accept(r.id, 'kari').ok).toBe(true);
    const second = sys.service.accept(r.id, 'ola');
    expect(second).toEqual({ ok: false, reason: 'Already taken by kari' });
    expect(sys.store.get(r.id)!.committedBy).toBe('kari');
  });

  it('a direct offer can only be accepted by the person it was offered to', () => {
    const sys = systemWithVolunteers();
    const r = sys.service.reportEmpty('OSLO', 'x');
    const someoneElse = ['ola', 'kari', 'nils'].find((p) => p !== r.offeredTo)!;
    expect(sys.service.accept(r.id, someoneElse).ok).toBe(false);
  });

  it('a stale write is rejected by compare-and-set (the race between read and write)', () => {
    const sys = systemWithVolunteers({ config: { maxDirectOffers: 0 } });
    const r = sys.service.reportEmpty('OSLO', 'x');
    // Two requests read the same version...
    const readByKari = sys.store.get(r.id)!;
    const readByOla = sys.store.get(r.id)!;
    // ...Kari's write lands first...
    sys.store.update({ ...readByKari, state: 'COMMITTED', committedBy: 'kari' });
    // ...so Ola's write, based on the old version, must fail instead of overwriting her.
    expect(() => sys.store.update({ ...readByOla, state: 'COMMITTED', committedBy: 'ola' })).toThrow(ConcurrencyError);
    expect(sys.store.get(r.id)!.committedBy).toBe('kari');
  });

  it('only the committed volunteer can record the purchase', () => {
    const sys = systemWithVolunteers({ config: { maxDirectOffers: 0 } });
    const r = sys.service.reportEmpty('OSLO', 'x');
    sys.service.accept(r.id, 'kari');
    const res = sys.service.recordPurchase(r.id, 'ola', { amount: money(500, 'NOK'), receiptImage: 'a.jpg' });
    expect(res.ok).toBe(false);
  });
});

describe('a refill nobody completes is handed to someone else', () => {
  it('an unanswered offer moves to the next candidate after the accept window', () => {
    const sys = systemWithVolunteers();
    const r = sys.service.reportEmpty('OSLO', 'x');
    const first = r.offeredTo!;
    sys.clock.advance(2 * HOUR);
    sys.service.tick();
    const after = sys.store.get(r.id)!;
    expect(after.state).toBe('OFFERED');
    expect(after.offeredTo).not.toBe(first);
    expect(after.passedOver).toContain(first);
  });

  it('a decline moves to the next candidate immediately', () => {
    const sys = systemWithVolunteers();
    const r = sys.service.reportEmpty('OSLO', 'x');
    const res = sys.service.decline(r.id, r.offeredTo!);
    expect(res.ok && res.value.offeredTo).not.toBe(r.offeredTo);
  });

  it('a volunteer who commits but never buys is released and the refill is re-offered', () => {
    const sys = systemWithVolunteers();
    const r = sys.service.reportEmpty('OSLO', 'x');
    const slacker = r.offeredTo!;
    sys.service.accept(r.id, slacker);
    expect(sys.service.budget.remaining('OSLO', sys.clock.now())).toEqual(money(5200, 'NOK')); // 800 reserved

    sys.clock.advance(24 * HOUR);
    sys.roster.checkIn('ola', 'OSLO', sys.clock.now());
    sys.roster.checkIn('kari', 'OSLO', sys.clock.now());
    sys.roster.checkIn('nils', 'OSLO', sys.clock.now());
    sys.service.tick();

    const after = sys.store.get(r.id)!;
    expect(after.state).toBe('OFFERED');
    expect(after.committedBy).toBeUndefined();
    expect(after.offeredTo).not.toBe(slacker);
    expect(sys.chat.dmsTo(slacker).at(-1)).toContain("don't buy");
    expect(sys.service.budget.remaining('OSLO', sys.clock.now())).toEqual(money(6000, 'NOK')); // reservation released
    // and the slacker can no longer record a purchase for it
    expect(sys.service.recordPurchase(r.id, slacker, { amount: money(500, 'NOK'), receiptImage: 'a.jpg' }).ok).toBe(false);
  });

  it('after N direct offers it broadcasts, then escalates to the coordinator if still nobody', () => {
    const sys = systemWithVolunteers({ config: { maxDirectOffers: 2 } });
    const r = sys.service.reportEmpty('OSLO', 'x');
    sys.clock.advance(2 * HOUR);
    sys.service.tick(); // 2nd direct offer
    sys.clock.advance(2 * HOUR);
    sys.service.tick(); // → broadcast
    expect(sys.store.get(r.id)!.state).toBe('BROADCAST');
    expect(sys.chat.channel.at(-1)!.text).toContain('First to accept');

    sys.clock.advance(4 * HOUR);
    sys.service.tick();
    expect(sys.store.get(r.id)!.escalated).toBe(true);
    expect(sys.chat.dmsTo('oslo-coordinator').at(-1)).toContain('needs attention');
  });

  it('escalates straight away when no volunteer is at the office at all', () => {
    const sys = systemWithVolunteers();
    const r = sys.service.reportEmpty('OSLO', 'x');
    // nobody checked in on a new day (e.g. everyone working from home)
    sys.clock.advance(2 * 24 * HOUR);
    sys.service.tick();
    expect(sys.store.get(r.id)!.state).toBe('BROADCAST');
    expect(sys.chat.dmsTo('oslo-coordinator').at(-1)).toContain('no volunteer is checked in');
  });
});
