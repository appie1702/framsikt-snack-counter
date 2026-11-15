import type { Office, OfficeId } from './domain.js';
import { FakeChat, FakeHr, FixedFxRates } from './fakes.js';
import { money } from './money.js';
import type { FxRates } from './ports.js';
import { RefillStore } from './refillStore.js';
import { Roster } from './roster.js';
import { DEFAULT_CONFIG, SnackService, type Config } from './snackService.js';
import { FakeClock } from './time.js';

/** Office configuration from the brief. Estimates sit mid-range of the "typical purchase". */
export function defaultOffices(): Record<OfficeId, Office> {
  return {
    OSLO: {
      id: 'OSLO',
      name: 'Oslo',
      timeZone: 'Europe/Oslo',
      currency: 'NOK',
      monthlyBudget: money(6000, 'NOK'),
      estimatedRefill: money(800, 'NOK'),
      coordinatorId: 'oslo-coordinator',
    },
    BLR: {
      id: 'BLR',
      name: 'Bengaluru',
      timeZone: 'Asia/Kolkata',
      currency: 'INR',
      monthlyBudget: money(15000, 'INR'),
      estimatedRefill: money(2000, 'INR'),
      coordinatorId: 'blr-coordinator',
    },
  };
}

/** Wires the service with simulated chat + HR. Used by tests and the demo. */
export function createSystem(opts: { now?: Date; config?: Partial<Config>; fx?: FxRates } = {}) {
  const offices = defaultOffices();
  const clock = new FakeClock(opts.now ?? new Date('2026-11-16T08:00:00Z'));
  const roster = new Roster(offices);
  const store = new RefillStore();
  const chat = new FakeChat();
  const hr = new FakeHr();
  const fx = opts.fx ?? new FixedFxRates();
  const service = new SnackService(offices, roster, store, chat, hr, fx, clock, { ...DEFAULT_CONFIG, ...opts.config });
  return { offices, clock, roster, store, chat, hr, fx, service };
}
