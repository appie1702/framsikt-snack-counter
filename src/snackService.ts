import { Budget } from './budget.js';
import {
  ACTIVE_STATES,
  OUTSTANDING_STATES,
  fail,
  ok,
  type EmployeeId,
  type Office,
  type OfficeId,
  type Refill,
  type Result,
} from './domain.js';
import { format, toDecimalString, type Money } from './money.js';
import { HrError, type ChatPort, type FxRates, type HrPort } from './ports.js';
import { ConcurrencyError, RefillStore } from './refillStore.js';
import type { Roster, VolunteerStats } from './roster.js';
import { DAY, HOUR, type Clock } from './time.js';

const localTime = (d: Date, timeZone: string) =>
  new Intl.DateTimeFormat('en-GB', { timeZone, weekday: 'short', hour: '2-digit', minute: '2-digit' }).format(d);

export interface Config {
  /** How long a directly-offered volunteer has to accept or decline. */
  acceptWindowMs: number;
  /** How long a volunteer has, after accepting, to buy and upload the receipt. */
  purchaseWindowMs: number;
  /** Direct offers before falling back to asking everyone available. */
  maxDirectOffers: number;
  /** If nobody picks up a broadcast within this time, tell the coordinator. */
  broadcastEscalateAfterMs: number;
  /** Nudge the coordinator if HR has not decided a claim within this time (brief: 1–10 days). */
  claimSlaMs: number;
}

export const DEFAULT_CONFIG: Config = {
  acceptWindowMs: 2 * HOUR,
  purchaseWindowMs: 24 * HOUR,
  maxDirectOffers: 3,
  broadcastEscalateAfterMs: 4 * HOUR,
  claimSlaMs: 10 * DAY,
};

export interface PurchaseInput {
  amount: Money;
  receiptImage: string;
  description?: string;
  tags?: string[];
}

/**
 * The refill lifecycle: who is asked, who commits, budget check, and the hand-off to HR.
 * All side effects go through ports (chat, HR, clock, FX), so the logic is fully testable.
 */
export class SnackService {
  readonly budget: Budget;
  private seq = 0;

  constructor(
    private readonly offices: Record<OfficeId, Office>,
    private readonly roster: Roster,
    readonly store: RefillStore,
    private readonly chat: ChatPort,
    private readonly hr: HrPort,
    private readonly fx: FxRates,
    private readonly clock: Clock,
    private readonly config: Config = DEFAULT_CONFIG,
  ) {
    this.budget = new Budget(offices, store);
  }

  // ───────────────────────────── 1. Empty → someone asked ─────────────────────────────

  /** Anyone can report the box empty. Idempotent: a second report returns the open refill. */
  reportEmpty(officeId: OfficeId, reportedBy: EmployeeId): Refill {
    const existing = this.store.activeFor(officeId);
    if (existing) return existing;

    const now = this.clock.now();
    const office = this.offices[officeId];
    const needsApproval = !this.budget.canAffordEstimate(officeId, now);

    const refill = this.store.insert({
      id: `R-${++this.seq}`,
      officeId,
      state: needsApproval ? 'AWAITING_BUDGET_APPROVAL' : 'OFFERED',
      version: 0,
      reportedAt: now,
      reportedBy,
      directOffers: 0,
      passedOver: [],
      escalated: false,
      overBudget: false,
    });

    if (needsApproval) {
      this.chat.sendDirect(
        office.coordinatorId,
        `${office.name} snack box is empty but only ${format(this.budget.remaining(officeId, now))} of the monthly budget is left. Approve refill ${refill.id}?`,
      );
      return refill;
    }
    return this.offerNext(refill);
  }

  /** Coordinator lets a refill go ahead even though the budget is (nearly) used up. */
  approveOverBudget(refillId: string, approver: EmployeeId): Result<Refill> {
    const r = this.store.get(refillId);
    if (!r) return fail('Refill not found');
    if (r.state !== 'AWAITING_BUDGET_APPROVAL') return fail(`Refill is ${r.state}`);
    if (this.offices[r.officeId].coordinatorId !== approver) return fail('Only the office coordinator can approve');
    r.budgetApprovedBy = approver;
    r.state = 'OFFERED';
    return this.write(r, (saved) => this.offerNext(saved));
  }

  // ───────────────────────────── 2. Commit: exactly one person ─────────────────────────────

  accept(refillId: string, employeeId: EmployeeId): Result<Refill> {
    const r = this.store.get(refillId);
    if (!r) return fail('Refill not found');
    if (r.state === 'COMMITTED' || !ACTIVE_STATES.has(r.state)) {
      return fail(r.committedBy ? `Already taken by ${r.committedBy}` : `Refill is ${r.state}`);
    }
    if (r.state === 'OFFERED' && r.offeredTo !== employeeId) return fail('This refill was offered to someone else');
    if (r.state === 'AWAITING_BUDGET_APPROVAL') return fail('Waiting for budget approval');
    const now = this.clock.now();
    if (!this.roster.isEligible(employeeId, r.officeId, now)) return fail('You are not checked in at this office today');

    r.state = 'COMMITTED';
    r.committedBy = employeeId;
    r.committedAt = now;
    r.purchaseDeadline = new Date(now.getTime() + this.config.purchaseWindowMs);
    r.offeredTo = undefined;
    r.offerExpiresAt = undefined;

    // Compare-and-set: if someone else committed between our read and this write, we lose cleanly.
    return this.write(r, (saved) => {
      this.chat.sendDirect(employeeId, `Thanks! Refill ${saved.id} is yours. Please buy and upload the receipt by ${localTime(saved.purchaseDeadline!, this.offices[saved.officeId].timeZone)}.`);
      this.chat.postToOfficeChannel(saved.officeId, `${employeeId} is refilling the snack box. No need for anyone else to buy.`);
      return saved;
    });
  }

  decline(refillId: string, employeeId: EmployeeId): Result<Refill> {
    const r = this.store.get(refillId);
    if (!r) return fail('Refill not found');
    if (r.state !== 'OFFERED' || r.offeredTo !== employeeId) return fail('Nothing to decline');
    r.passedOver.push(employeeId);
    return this.write(r, (saved) => this.offerNext(saved));
  }

  // ───────────────────────────── 3. Purchase → claim → reimbursed ─────────────────────────────

  recordPurchase(refillId: string, employeeId: EmployeeId, input: PurchaseInput): Result<Refill> {
    const r = this.store.get(refillId);
    if (!r) return fail('Refill not found');
    if (r.state !== 'COMMITTED' || r.committedBy !== employeeId) return fail('Only the committed volunteer can record this purchase');
    const office = this.offices[r.officeId];
    if (input.amount.currency !== office.currency) return fail(`Receipt must be in ${office.currency} (bought locally for ${office.name})`);
    if (input.amount.minor <= 0) return fail('Amount must be positive');
    if (!input.receiptImage) return fail('Receipt image is required');

    const now = this.clock.now();
    r.purchase = {
      amount: input.amount,
      purchasedAt: now,
      receiptImage: input.receiptImage,
      description: input.description ?? `Snack refill ${office.name}`,
      tags: input.tags ?? [],
    };
    r.state = 'PURCHASED';
    r.purchaseDeadline = undefined;

    const saved = this.write(r, (s) => s);
    if (!saved.ok) return saved;

    // Settle: the real amount replaces the reservation. Flag (never block) if it went over; money is already spent.
    if (this.budget.remaining(r.officeId, now).minor < 0) {
      const flagged = this.store.get(refillId)!;
      flagged.overBudget = true;
      this.store.update(flagged);
      this.chat.sendDirect(office.coordinatorId, `${office.name} is over its monthly snack budget after refill ${refillId} (${format(input.amount)}).`);
    }
    this.chat.postToOfficeChannel(r.officeId, `Snack box restocked by ${employeeId}. Thank you!`);
    return ok(this.submitClaim(refillId));
  }

  /**
   * Send the claim to HR at most once per refill.
   * - unavailable → nothing was created, keep it for retry on the next tick
   * - timeout     → HR may or may not have created it; retrying could pay twice, so a human reconciles
   */
  private submitClaim(refillId: string): Refill {
    const r = this.store.get(refillId)!;
    if (r.state !== 'PURCHASED' || r.claim?.hrClaimId) return r; // already submitted → no-op
    const purchase = r.purchase!;
    const attempts = (r.claim?.attempts ?? 0) + 1;
    try {
      const { claimId } = this.hr.createClaim({
        employeeId: r.committedBy!,
        amount: toDecimalString(purchase.amount),
        currency: purchase.amount.currency,
        description: `${purchase.description} [ref ${r.id}]`,
        receiptImage: purchase.receiptImage,
        reference: r.id,
      });
      r.claim = { status: 'SUBMITTED', attempts, hrClaimId: claimId, submittedAt: this.clock.now() };
      r.state = 'CLAIM_SUBMITTED';
    } catch (e) {
      if (!(e instanceof HrError)) throw e;
      if (e.kind === 'unavailable') {
        r.claim = { status: 'RETRY_PENDING', attempts, lastError: e.message };
      } else {
        r.claim = { status: 'UNKNOWN', attempts, lastError: e.message };
        r.state = 'CLAIM_NEEDS_RECONCILIATION';
        const office = this.offices[r.officeId];
        this.chat.sendDirect(office.coordinatorId, `HR did not confirm the claim for refill ${r.id}. Please check HR for reference ${r.id} before resubmitting.`);
      }
    }
    return this.store.update(r);
  }

  /** Poll HR for decisions (a webhook adapter would call the same logic). */
  syncClaims(): void {
    const now = this.clock.now();
    for (const r of this.store.all()) {
      if (r.state !== 'CLAIM_SUBMITTED' || !r.claim?.hrClaimId) continue;
      const status = this.hr.getClaimStatus(r.claim.hrClaimId);
      const who = r.committedBy!;
      if (status === 'APPROVED') {
        r.state = 'REIMBURSED';
        r.claim.status = 'APPROVED';
        r.reimbursedAt = now;
        this.chat.sendDirect(who, `Your snack claim for refill ${r.id} (${format(r.purchase!.amount)}) was approved.`);
      } else if (status === 'REJECTED') {
        r.state = 'CLAIM_REJECTED';
        r.claim.status = 'REJECTED';
        this.chat.sendDirect(who, `Your snack claim for refill ${r.id} was rejected by HR. Your coordinator has been told.`);
        this.chat.sendDirect(this.offices[r.officeId].coordinatorId, `HR rejected claim for refill ${r.id} (${who}, ${format(r.purchase!.amount)}). Please follow up.`);
      } else if (!r.claim.slaNudged && now.getTime() - r.claim.submittedAt!.getTime() > this.config.claimSlaMs) {
        r.claim.slaNudged = true;
        this.chat.sendDirect(this.offices[r.officeId].coordinatorId, `Claim ${r.claim.hrClaimId} for refill ${r.id} has waited more than 10 days at HR.`);
      } else {
        continue;
      }
      this.store.update(r);
    }
  }

  // ───────────────────────────── 4. Timers ─────────────────────────────

  /** Called periodically (e.g. every few minutes by a scheduler). Handles every deadline. */
  tick(): void {
    const now = this.clock.now();
    for (const r of this.store.all()) {
      if (r.state === 'OFFERED' && r.offerExpiresAt && now >= r.offerExpiresAt) {
        this.chat.sendDirect(r.offeredTo!, `No reply on refill ${r.id}, so we asked someone else.`);
        r.passedOver.push(r.offeredTo!);
        this.write(r, (s) => this.offerNext(s));
      } else if (r.state === 'COMMITTED' && r.purchaseDeadline && now >= r.purchaseDeadline) {
        // Abandoned: release the person (and, implicitly, the budget reservation) and hand it on.
        const who = r.committedBy!;
        this.chat.sendDirect(who, `Refill ${r.id} was not completed in time, so it has been handed to someone else. Please don't buy snacks for it now.`);
        r.passedOver.push(who);
        r.committedBy = undefined;
        r.committedAt = undefined;
        r.purchaseDeadline = undefined;
        r.state = 'OFFERED';
        this.write(r, (s) => this.offerNext(s));
      } else if (r.state === 'BROADCAST' && !r.escalated && r.broadcastAt && now.getTime() - r.broadcastAt.getTime() >= this.config.broadcastEscalateAfterMs) {
        r.escalated = true;
        this.write(r, (s) => {
          this.escalate(s, 'nobody has picked up the broadcast');
          return s;
        });
      } else if (r.state === 'PURCHASED' && r.claim?.status === 'RETRY_PENDING') {
        this.submitClaim(r.id);
      }
    }
  }

  // ───────────────────────────── Queries ─────────────────────────────

  statsFor(employeeId: EmployeeId): VolunteerStats {
    const now = this.clock.now();
    let outstandingMinor = 0;
    let refillsLast30Days = 0;
    let lastRefillAt: Date | undefined;
    for (const r of this.store.all()) {
      if (r.committedBy !== employeeId || !r.purchase) continue;
      const at = r.purchase.purchasedAt;
      if (OUTSTANDING_STATES.has(r.state)) {
        // Normalise to NOK so a visitor's INR and NOK debts are comparable.
        outstandingMinor += Math.round(r.purchase.amount.minor * this.fx.rate(r.purchase.amount.currency, 'NOK', at));
      }
      if (now.getTime() - at.getTime() <= 30 * DAY) refillsLast30Days++;
      if (!lastRefillAt || at > lastRefillAt) lastRefillAt = at;
    }
    return { outstandingMinor, refillsLast30Days, lastRefillAt };
  }

  // ───────────────────────────── Internals ─────────────────────────────

  /** Pick the next person, or broadcast after N direct offers. Expects a freshly-saved refill. */
  private offerNext(r: Refill): Refill {
    const now = this.clock.now();
    const office = this.offices[r.officeId];
    const candidates = this.roster.rankCandidates(r.officeId, now, new Set(r.passedOver), (id) => this.statsFor(id));
    const best = candidates[0];

    if (best && r.directOffers < this.config.maxDirectOffers) {
      r.state = 'OFFERED';
      r.offeredTo = best.employeeId;
      r.offerExpiresAt = new Date(now.getTime() + this.config.acceptWindowMs);
      r.directOffers++;
      const saved = this.store.update(r);
      this.chat.sendDirect(
        best.employeeId,
        `The ${office.name} snack box is empty. Can you refill it today (budget ~${format(office.estimatedRefill)})? Accept or decline refill ${r.id} within ${this.config.acceptWindowMs / HOUR}h.`,
      );
      return saved;
    }

    r.state = 'BROADCAST';
    r.offeredTo = undefined;
    r.offerExpiresAt = undefined;
    r.broadcastAt = now;
    const saved = this.store.update(r);
    this.chat.postToOfficeChannel(r.officeId, `The snack box is empty and still needs a volunteer. First to accept refill ${r.id} gets it.`);
    if (candidates.length === 0 && !saved.escalated) {
      saved.escalated = true;
      const escalated = this.store.update(saved);
      this.escalate(escalated, 'no volunteer is checked in at the office');
      return escalated;
    }
    return saved;
  }

  private escalate(r: Refill, why: string): void {
    const office = this.offices[r.officeId];
    this.chat.sendDirect(office.coordinatorId, `Refill ${r.id} at ${office.name} needs attention: ${why}.`);
  }

  /** Persist with compare-and-set; a concurrent change becomes a clean failure, not a double booking. */
  private write(r: Refill, then: (saved: Refill) => Refill): Result<Refill> {
    try {
      return ok(then(this.store.update(r)));
    } catch (e) {
      if (e instanceof ConcurrencyError) return fail('Someone else updated this refill first. Please try again.');
      throw e;
    }
  }
}
