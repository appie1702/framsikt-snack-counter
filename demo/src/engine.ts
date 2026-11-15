// Wires the REAL core (../../src) with demo-friendly simulated chat + HR.
import type { OfficeId } from '../../src/domain';
import { FakeHr, FixedFxRates } from '../../src/fakes';
import type { ChatPort } from '../../src/ports';
import { RefillStore } from '../../src/refillStore';
import { Roster } from '../../src/roster';
import { defaultOffices } from '../../src/setup';
import { DEFAULT_CONFIG, SnackService } from '../../src/snackService';
import { FakeClock, type Clock } from '../../src/time';

export interface ChatMsg {
  at: Date;
  channel: boolean;
  to: string;
  text: string;
}

class DemoChat implements ChatPort {
  msgs: ChatMsg[] = [];
  constructor(private clock: Clock) {}
  sendDirect(to: string, text: string) {
    this.msgs.push({ at: this.clock.now(), channel: false, to, text });
  }
  postToOfficeChannel(officeId: OfficeId, text: string) {
    this.msgs.push({ at: this.clock.now(), channel: true, to: `#snacks-${officeId.toLowerCase()}`, text });
  }
}

export type Location = OfficeId | 'AWAY';

export const PEOPLE: { id: string; name: string; home: OfficeId }[] = [
  { id: 'kari', name: 'Kari', home: 'OSLO' },
  { id: 'ola', name: 'Ola', home: 'OSLO' },
  { id: 'nils', name: 'Nils', home: 'OSLO' },
  { id: 'ingrid', name: 'Ingrid', home: 'OSLO' },
  { id: 'priya', name: 'Priya', home: 'BLR' },
  { id: 'arjun', name: 'Arjun', home: 'BLR' },
  { id: 'meera', name: 'Meera', home: 'BLR' },
  { id: 'rahul', name: 'Rahul', home: 'BLR' },
];

export function createDemo() {
  const offices = defaultOffices();
  // Monday 16 Nov 2026, 08:30 in Oslo / 13:00 in Bengaluru
  const clock = new FakeClock(new Date('2026-11-16T07:30:00Z'));
  const roster = new Roster(offices);
  const store = new RefillStore();
  const chat = new DemoChat(clock);
  const hr = new FakeHr();
  const fx = new FixedFxRates();
  const service = new SnackService(offices, roster, store, chat, hr, fx, clock, DEFAULT_CONFIG);

  const location = new Map<string, Location>();
  for (const p of PEOPLE) {
    roster.addVolunteer({ employeeId: p.id, name: p.name, homeOffice: p.home, active: true });
    location.set(p.id, p.home);
  }

  /** Demo convenience: each "morning" people check in wherever the location picker says they are. */
  const applyCheckIns = () => {
    const now = clock.now();
    for (const p of PEOPLE) {
      roster.checkOut(p.id, 'OSLO', now);
      roster.checkOut(p.id, 'BLR', now);
      const loc = location.get(p.id)!;
      if (loc !== 'AWAY') roster.checkIn(p.id, loc, now);
    }
  };
  applyCheckIns();

  return { offices, clock, roster, store, chat, hr, fx, service, location, applyCheckIns };
}

export type Demo = ReturnType<typeof createDemo>;
