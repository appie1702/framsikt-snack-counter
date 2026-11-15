import type { EmployeeId, Office, OfficeId, Volunteer } from './domain.js';
import { localDate } from './time.js';

/** Per-candidate numbers used for fair selection. Computed fresh each time (n ≤ ~20). */
export interface VolunteerStats {
  /** Money paid out of pocket and not yet reimbursed, normalised to one currency (minor units). */
  outstandingMinor: number;
  refillsLast30Days: number;
  lastRefillAt?: Date;
}

/**
 * Who volunteers, and who is physically at which office on which day.
 *
 * Availability source (assumption, no calendar/leave integration): volunteers check in via chat
 * ("I'm at the Oslo office today"). No check-in = not available. This covers hybrid work,
 * holidays (simply no check-in) and visitors (check in at the other office).
 */
export class Roster {
  private readonly volunteers = new Map<EmployeeId, Volunteer>();
  /** key: `${officeId}|${localDate}` → set of employees present. */
  private readonly presence = new Map<string, Set<EmployeeId>>();

  constructor(private readonly offices: Record<OfficeId, Office>) {}

  addVolunteer(v: Volunteer): void {
    this.volunteers.set(v.employeeId, { ...v });
  }

  setActive(employeeId: EmployeeId, active: boolean): void {
    const v = this.volunteers.get(employeeId);
    if (v) v.active = active;
  }

  get(employeeId: EmployeeId): Volunteer | undefined {
    return this.volunteers.get(employeeId);
  }

  checkIn(employeeId: EmployeeId, officeId: OfficeId, at: Date): void {
    const key = this.key(officeId, at);
    if (!this.presence.has(key)) this.presence.set(key, new Set());
    this.presence.get(key)!.add(employeeId);
  }

  checkOut(employeeId: EmployeeId, officeId: OfficeId, at: Date): void {
    this.presence.get(this.key(officeId, at))?.delete(employeeId);
  }

  /** Active volunteer (from either office) who is at this office today. */
  isEligible(employeeId: EmployeeId, officeId: OfficeId, at: Date): boolean {
    const v = this.volunteers.get(employeeId);
    return !!v && v.active && (this.presence.get(this.key(officeId, at))?.has(employeeId) ?? false);
  }

  /**
   * Candidates for a refill, best first.
   * Order: least money outstanding → fewest refills in 30 days → longest since last refill → id.
   * A plain sort: n ≤ 20, so O(n log n) is nothing, and recomputing avoids stale cached state.
   */
  rankCandidates(
    officeId: OfficeId,
    at: Date,
    exclude: ReadonlySet<EmployeeId>,
    statsFor: (id: EmployeeId) => VolunteerStats,
  ): Volunteer[] {
    const eligible = [...this.volunteers.values()].filter(
      (v) => !exclude.has(v.employeeId) && this.isEligible(v.employeeId, officeId, at),
    );
    const withStats = eligible.map((v) => ({ v, s: statsFor(v.employeeId) }));
    withStats.sort(
      (a, b) =>
        a.s.outstandingMinor - b.s.outstandingMinor ||
        a.s.refillsLast30Days - b.s.refillsLast30Days ||
        (a.s.lastRefillAt?.getTime() ?? 0) - (b.s.lastRefillAt?.getTime() ?? 0) ||
        a.v.employeeId.localeCompare(b.v.employeeId),
    );
    return withStats.map((x) => x.v);
  }

  private key(officeId: OfficeId, at: Date): string {
    return `${officeId}|${localDate(at, this.offices[officeId].timeZone)}`;
  }
}
