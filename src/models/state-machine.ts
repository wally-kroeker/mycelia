import type { RequestStatus, ClaimStatus } from '../types';

/**
 * Valid state transitions for requests.
 *
 * State diagram:
 *   open → claimed → responded → rated → closed
 *   open → cancelled | expired
 *   claimed → open (claim expires, no responses)
 *   claimed → cancelled (no responses)
 */

interface TransitionRule {
  from: RequestStatus;
  to: RequestStatus;
  trigger: string;
  condition?: string;
}

const REQUEST_TRANSITIONS: TransitionRule[] = [
  { from: 'open', to: 'claimed', trigger: 'claim_created', condition: 'not_expired_and_under_max' },
  { from: 'open', to: 'cancelled', trigger: 'requester_cancels', condition: 'zero_responses' },
  { from: 'open', to: 'expired', trigger: 'cron_expiry', condition: 'past_expires_at' },
  { from: 'claimed', to: 'open', trigger: 'all_claims_expired', condition: 'zero_responses_and_no_active_claims' },
  { from: 'claimed', to: 'responded', trigger: 'response_submitted' },
  { from: 'claimed', to: 'cancelled', trigger: 'requester_cancels', condition: 'zero_responses' },
  { from: 'responded', to: 'responded', trigger: 'additional_response', condition: 'under_max_responses' },
  { from: 'responded', to: 'rated', trigger: 'rating_submitted' },
  { from: 'rated', to: 'rated', trigger: 'additional_rating' },
  { from: 'rated', to: 'closed', trigger: 'all_rated_or_manual_close' },
];

/**
 * Check if a request status transition is valid.
 */
export function canTransition(from: RequestStatus, to: RequestStatus): boolean {
  return REQUEST_TRANSITIONS.some((t) => t.from === from && t.to === to);
}

/**
 * Get the transition rule for a given from→to pair, or null if invalid.
 */
export function getTransition(from: RequestStatus, to: RequestStatus): TransitionRule | null {
  return REQUEST_TRANSITIONS.find((t) => t.from === from && t.to === to) ?? null;
}

/**
 * Determine the next request status after a claim is created.
 * Requests stay claimable until terminal (closed/expired/cancelled)
 * as long as response_count < max_responses.
 */
export function afterClaimCreated(currentStatus: RequestStatus): RequestStatus {
  const terminal: RequestStatus[] = ['closed', 'expired', 'cancelled'];
  if (terminal.includes(currentStatus)) {
    throw new InvalidTransitionError(currentStatus, 'claimed', 'Cannot claim terminal requests');
  }
  // If already responded/rated, keep that status — a new claim doesn't regress state
  if (currentStatus === 'responded' || currentStatus === 'rated') return currentStatus;
  return 'claimed';
}

/**
 * Determine the next request status after a response is submitted.
 * Accepts claimed, responded, or rated — new responses don't regress state.
 */
export function afterResponseSubmitted(currentStatus: RequestStatus): RequestStatus {
  if (currentStatus === 'claimed' || currentStatus === 'responded') return 'responded';
  if (currentStatus === 'rated') return 'rated'; // Don't regress from rated
  throw new InvalidTransitionError(currentStatus, 'responded', 'Can only respond to claimed, responded, or rated requests');
}

/**
 * Determine the next request status after a rating is submitted.
 */
export function afterRatingSubmitted(currentStatus: RequestStatus): RequestStatus {
  if (currentStatus === 'responded' || currentStatus === 'rated') return 'rated';
  throw new InvalidTransitionError(currentStatus, 'rated', 'Can only rate responded or rated requests');
}

/**
 * Determine the next request status when closing.
 */
export function afterClose(currentStatus: RequestStatus): RequestStatus {
  if (currentStatus === 'rated') return 'closed';
  throw new InvalidTransitionError(currentStatus, 'closed', 'Can only close rated requests');
}

/**
 * Determine the next request status when cancelling.
 */
export function afterCancel(currentStatus: RequestStatus, responseCount: number): RequestStatus {
  if ((currentStatus === 'open' || currentStatus === 'claimed') && responseCount === 0) {
    return 'cancelled';
  }
  throw new InvalidTransitionError(currentStatus, 'cancelled', 'Can only cancel open/claimed requests with 0 responses');
}

/**
 * Determine the next request status on expiry.
 */
export function afterExpiry(currentStatus: RequestStatus): RequestStatus {
  if (currentStatus === 'open') return 'expired';
  throw new InvalidTransitionError(currentStatus, 'expired', 'Only open requests can expire');
}

/**
 * Determine the next request status when all claims expire with no responses.
 */
export function afterAllClaimsExpired(
  currentStatus: RequestStatus,
  activeClaimCount: number,
  responseCount: number
): RequestStatus {
  if (currentStatus === 'claimed' && activeClaimCount === 0 && responseCount === 0) {
    return 'open';
  }
  throw new InvalidTransitionError(currentStatus, 'open', 'Cannot reopen: still has active claims or responses');
}

// ═══ Claim Status Transitions ═══

export function claimAfterResponse(): ClaimStatus {
  return 'completed';
}

export function claimAfterExpiry(): ClaimStatus {
  return 'expired';
}

export function claimAfterAbandon(): ClaimStatus {
  return 'abandoned';
}

// ═══ Error ═══

export class InvalidTransitionError extends Error {
  constructor(
    public readonly from: string,
    public readonly to: string,
    public readonly reason: string
  ) {
    super(`Invalid transition: ${from} → ${to}. ${reason}`);
    this.name = 'InvalidTransitionError';
  }
}
