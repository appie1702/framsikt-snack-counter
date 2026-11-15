import { describe, expect, it } from 'vitest';
import { money } from '../src/money.js';
import { DAY } from '../src/time.js';
import { systemWithVolunteers } from './helpers.js';

function commit(sys: ReturnType<typeof systemWithVolunteers>) {
  const r = sys.service.reportEmpty('OSLO', 'x');
  const who = r.offeredTo!;
  sys.service.accept(r.id, who);
  return { id: r.id, who };
}

describe('HR claims: exactly one claim per refill', () => {
  it('retries on the next tick when HR is down, and creates only one claim', () => {
    const sys = systemWithVolunteers();
    sys.hr.failNext = ['unavailable'];
    const { id, who } = commit(sys);
    sys.service.recordPurchase(id, who, { amount: money(600, 'NOK'), receiptImage: 'a.jpg' });
    expect(sys.store.get(id)!.state).toBe('PURCHASED');
    expect(sys.store.get(id)!.claim!.status).toBe('RETRY_PENDING');
    expect(sys.hr.claims.size).toBe(0);

    sys.service.tick();
    sys.service.tick(); // a second tick must not submit again
    expect(sys.store.get(id)!.state).toBe('CLAIM_SUBMITTED');
    expect(sys.store.get(id)!.claim!.attempts).toBe(2);
    expect(sys.hr.claims.size).toBe(1);
  });

  it('does NOT blindly retry when the outcome is unknown (timeout), to avoid paying twice', () => {
    const sys = systemWithVolunteers();
    sys.hr.failNext = ['timeout'];
    const { id, who } = commit(sys);
    sys.service.recordPurchase(id, who, { amount: money(600, 'NOK'), receiptImage: 'a.jpg' });
    expect(sys.store.get(id)!.state).toBe('CLAIM_NEEDS_RECONCILIATION');
    sys.service.tick();
    expect(sys.hr.claims.size).toBe(1); // HR did create it; we did not create a second one
    expect(sys.chat.dmsTo('oslo-coordinator').at(-1)).toContain(`reference ${id}`);
  });

  it('tells the volunteer and coordinator when HR rejects a claim', () => {
    const sys = systemWithVolunteers();
    const { id, who } = commit(sys);
    sys.service.recordPurchase(id, who, { amount: money(600, 'NOK'), receiptImage: 'a.jpg' });
    sys.hr.decide(sys.store.get(id)!.claim!.hrClaimId!, 'REJECTED');
    sys.service.syncClaims();
    expect(sys.store.get(id)!.state).toBe('CLAIM_REJECTED');
    expect(sys.chat.dmsTo(who).at(-1)).toContain('rejected');
    expect(sys.chat.dmsTo('oslo-coordinator').at(-1)).toContain('rejected');
  });

  it('nudges the coordinator once if HR has not decided within 10 days', () => {
    const sys = systemWithVolunteers();
    const { id, who } = commit(sys);
    sys.service.recordPurchase(id, who, { amount: money(600, 'NOK'), receiptImage: 'a.jpg' });
    sys.clock.advance(11 * DAY);
    sys.service.syncClaims();
    sys.service.syncClaims();
    const nudges = sys.chat.dmsTo('oslo-coordinator').filter((t) => t.includes('more than 10 days'));
    expect(nudges).toHaveLength(1);
  });
});
