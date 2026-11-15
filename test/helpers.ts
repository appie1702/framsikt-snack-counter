import type { OfficeId } from '../src/domain.js';
import { createSystem } from '../src/setup.js';

/** A system with a few volunteers checked in today. */
export function systemWithVolunteers(opts: Parameters<typeof createSystem>[0] = {}) {
  const sys = createSystem(opts);
  const add = (id: string, home: OfficeId, checkInAt: OfficeId | null = home) => {
    sys.roster.addVolunteer({ employeeId: id, name: id, homeOffice: home, active: true });
    if (checkInAt) sys.roster.checkIn(id, checkInAt, sys.clock.now());
  };
  add('ola', 'OSLO');
  add('kari', 'OSLO');
  add('nils', 'OSLO');
  add('priya', 'BLR');
  add('arjun', 'BLR');
  return { ...sys, add };
}

export type Sys = ReturnType<typeof systemWithVolunteers>;

/** Report → accept → purchase in one go; returns the refill id. */
export function completeRefill(sys: Sys, officeId: OfficeId, amountMajor: number) {
  const r = sys.service.reportEmpty(officeId, 'someone');
  const who = r.offeredTo!;
  const accepted = sys.service.accept(r.id, who);
  if (!accepted.ok) throw new Error(accepted.reason);
  const currency = sys.offices[officeId].currency;
  const bought = sys.service.recordPurchase(r.id, who, {
    amount: { minor: Math.round(amountMajor * 100), currency },
    receiptImage: `receipt-${r.id}.jpg`,
  });
  if (!bought.ok) throw new Error(bought.reason);
  return { id: r.id, who };
}
