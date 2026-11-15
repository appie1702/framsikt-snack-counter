import type { EmployeeId, OfficeId } from './domain.js';
import type { Currency } from './money.js';
import { HrError, type ChatPort, type FxRates, type HrClaimRequest, type HrClaimStatus, type HrPort } from './ports.js';

/** Simulated chat tool: records every message so tests can assert on them. */
export class FakeChat implements ChatPort {
  readonly direct: { to: EmployeeId; text: string }[] = [];
  readonly channel: { officeId: OfficeId; text: string }[] = [];

  sendDirect(to: EmployeeId, text: string): void {
    this.direct.push({ to, text });
  }
  postToOfficeChannel(officeId: OfficeId, text: string): void {
    this.channel.push({ officeId, text });
  }
  dmsTo(to: EmployeeId): string[] {
    return this.direct.filter((m) => m.to === to).map((m) => m.text);
  }
}

/** Simulated external HR system with failure injection. */
export class FakeHr implements HrPort {
  readonly claims = new Map<string, HrClaimRequest & { status: HrClaimStatus }>();
  private nextId = 1;
  /** Queue of failures to throw on the next createClaim calls. */
  failNext: ('unavailable' | 'timeout')[] = [];

  createClaim(req: HrClaimRequest): { claimId: string } {
    const failure = this.failNext.shift();
    if (failure === 'unavailable') throw new HrError('unavailable', 'HR returned 503');
    const claimId = `HR-${this.nextId++}`;
    this.claims.set(claimId, { ...req, status: 'PENDING' });
    // A timeout after the claim was created: the worst case for duplicates.
    if (failure === 'timeout') throw new HrError('timeout', 'HR request timed out');
    return { claimId };
  }

  getClaimStatus(claimId: string): HrClaimStatus {
    const c = this.claims.get(claimId);
    if (!c) throw new Error(`Unknown claim ${claimId}`);
    return c.status;
  }

  /** Test helper: HR staff approve / reject. */
  decide(claimId: string, status: HrClaimStatus): void {
    const c = this.claims.get(claimId);
    if (!c) throw new Error(`Unknown claim ${claimId}`);
    c.status = status;
  }
}

/** Fixed rate table (NOK per unit). A real adapter would read e.g. Norges Bank daily rates. */
export class FixedFxRates implements FxRates {
  constructor(private readonly nokPerUnit: Record<Currency, number> = { NOK: 1, INR: 0.125 }) {}
  rate(from: Currency, to: Currency): number {
    return this.nokPerUnit[from] / this.nokPerUnit[to];
  }
}
