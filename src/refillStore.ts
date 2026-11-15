import { ACTIVE_STATES, type OfficeId, type Refill } from './domain.js';

export class ConcurrencyError extends Error {}
export class ActiveRefillExistsError extends Error {}

/**
 * In-memory stand-in for a `Refills` table.
 *
 * The two guarantees it gives map directly to SQL Server:
 *  - insert:  at most one ACTIVE refill per office
 *             → filtered unique index ON Refills(OfficeId) WHERE State IN (...active states)
 *  - update:  compare-and-set on version
 *             → UPDATE Refills SET ..., Version = Version + 1 WHERE Id = @id AND Version = @expected
 */
export class RefillStore {
  private readonly rows = new Map<string, Refill>();

  get(id: string): Refill | undefined {
    const r = this.rows.get(id);
    return r ? structuredClone(r) : undefined;
  }

  all(): Refill[] {
    return [...this.rows.values()].map((r) => structuredClone(r));
  }

  activeFor(officeId: OfficeId): Refill | undefined {
    return this.all().find((r) => r.officeId === officeId && ACTIVE_STATES.has(r.state));
  }

  insert(refill: Refill): Refill {
    if (this.activeFor(refill.officeId)) throw new ActiveRefillExistsError(`Office ${refill.officeId} already has an active refill`);
    const stored = { ...structuredClone(refill), version: 1 };
    this.rows.set(stored.id, stored);
    return structuredClone(stored);
  }

  /** Write `next` only if the stored version still equals `next.version` (the version the caller read). */
  update(next: Refill): Refill {
    const current = this.rows.get(next.id);
    if (!current) throw new Error(`Refill ${next.id} not found`);
    if (current.version !== next.version) {
      throw new ConcurrencyError(`Refill ${next.id} changed (expected v${next.version}, found v${current.version})`);
    }
    const stored = { ...structuredClone(next), version: current.version + 1 };
    this.rows.set(stored.id, stored);
    return structuredClone(stored);
  }
}
