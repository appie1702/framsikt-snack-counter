import type { EmployeeId, OfficeId } from './domain.js';
import type { Currency } from './money.js';

/** Company chat tool. Real adapter would be a bot; tests use FakeChat. */
export interface ChatPort {
  sendDirect(to: EmployeeId, text: string): void;
  postToOfficeChannel(officeId: OfficeId, text: string): void;
}

/** What the external HR system accepts (per the brief). */
export interface HrClaimRequest {
  employeeId: EmployeeId;
  amount: string; // decimal string, e.g. "845.50"
  currency: Currency;
  description: string;
  receiptImage: string;
  /** Our refill id, put in the description/reference so humans can reconcile. */
  reference: string;
}

export type HrClaimStatus = 'PENDING' | 'APPROVED' | 'REJECTED';

/**
 * - `unavailable`: request definitely did not create a claim (connection refused, 503) → safe to retry.
 * - `timeout`: we do not know whether the claim was created → retrying could double-pay, so a human reconciles.
 */
export class HrError extends Error {
  constructor(public readonly kind: 'unavailable' | 'timeout', message?: string) {
    super(message ?? kind);
  }
}

export interface HrPort {
  createClaim(req: HrClaimRequest): { claimId: string };
  getClaimStatus(claimId: string): HrClaimStatus;
}

/** Exchange rates, used only for reporting and for comparing outstanding amounts. */
export interface FxRates {
  /** How many units of `to` one unit of `from` is worth on the given date. */
  rate(from: Currency, to: Currency, on: Date): number;
}
