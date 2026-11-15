import type { Currency, Money } from './money.js';

export type OfficeId = 'OSLO' | 'BLR';
export type EmployeeId = string;

export interface Office {
  id: OfficeId;
  name: string;
  timeZone: string;
  currency: Currency;
  monthlyBudget: Money;
  /** Amount reserved from the budget when someone commits, before the real receipt exists. */
  estimatedRefill: Money;
  /** Escalation point: nobody accepts, over budget, claim rejected / unknown. */
  coordinatorId: EmployeeId;
}

export interface Volunteer {
  employeeId: EmployeeId;
  name: string;
  homeOffice: OfficeId;
  active: boolean;
}

/**
 * Refill lifecycle:
 *   AWAITING_BUDGET_APPROVAL ─approve─┐
 *   (report empty) ──────────────────►OFFERED ⇄ (decline / timeout → next candidate)
 *                                       │  └─ after N direct offers ─► BROADCAST
 *                                       ▼ accept (compare-and-set)
 *                                   COMMITTED ── purchase timeout ─► back to OFFERED/BROADCAST
 *                                       ▼ receipt
 *                                   PURCHASED ── HR unavailable → retry on tick
 *                                       ▼ claim created
 *                                 CLAIM_SUBMITTED ─► REIMBURSED | CLAIM_REJECTED
 *        (HR call timed out, outcome unknown) ─► CLAIM_NEEDS_RECONCILIATION
 */
export type RefillState =
  | 'AWAITING_BUDGET_APPROVAL'
  | 'OFFERED'
  | 'BROADCAST'
  | 'COMMITTED'
  | 'PURCHASED'
  | 'CLAIM_SUBMITTED'
  | 'REIMBURSED'
  | 'CLAIM_REJECTED'
  | 'CLAIM_NEEDS_RECONCILIATION';

/** States in which the box is still empty and the refill "occupies" the office. */
export const ACTIVE_STATES: ReadonlySet<RefillState> = new Set([
  'AWAITING_BUDGET_APPROVAL',
  'OFFERED',
  'BROADCAST',
  'COMMITTED',
]);

/** States in which a volunteer has paid and is still waiting for their money. */
export const OUTSTANDING_STATES: ReadonlySet<RefillState> = new Set([
  'PURCHASED',
  'CLAIM_SUBMITTED',
  'CLAIM_REJECTED',
  'CLAIM_NEEDS_RECONCILIATION',
]);

export interface Purchase {
  amount: Money;
  purchasedAt: Date;
  receiptImage: string;
  description: string;
  tags: string[];
}

export type ClaimStatus = 'RETRY_PENDING' | 'SUBMITTED' | 'APPROVED' | 'REJECTED' | 'UNKNOWN';

export interface ClaimRecord {
  status: ClaimStatus;
  attempts: number;
  hrClaimId?: string;
  submittedAt?: Date;
  lastError?: string;
  slaNudged?: boolean;
}

export interface Refill {
  id: string;
  officeId: OfficeId;
  state: RefillState;
  /** Optimistic-concurrency version; every write must present the version it read. */
  version: number;
  reportedAt: Date;
  reportedBy: EmployeeId;

  offeredTo?: EmployeeId;
  offerExpiresAt?: Date;
  directOffers: number;
  /** People who declined or let the offer/commitment lapse on this refill. */
  passedOver: EmployeeId[];
  broadcastAt?: Date;
  escalated: boolean;
  budgetApprovedBy?: EmployeeId;

  committedBy?: EmployeeId;
  committedAt?: Date;
  purchaseDeadline?: Date;

  purchase?: Purchase;
  overBudget: boolean;
  claim?: ClaimRecord;
  reimbursedAt?: Date;
}

export type Result<T> = { ok: true; value: T } | { ok: false; reason: string };
export const ok = <T>(value: T): Result<T> => ({ ok: true, value });
export const fail = <T>(reason: string): Result<T> => ({ ok: false, reason });
