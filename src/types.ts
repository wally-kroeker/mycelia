// src/types.ts

// ═══ Cloudflare Bindings ═══

export interface Env {
  DB: D1Database;
  KV: KVNamespace;
  R2_AUDIT?: R2Bucket; // Optional — enable R2 in CF dashboard first
  ENVIRONMENT: string;
  ADMIN_API_KEY?: string;
  ADMIN_OWNER_ID?: string; // owner_id authorized for admin revoke/unrevoke (wally-test in dev)
  // MODE — trust-enforcement spectrum. Required; node refuses to start without a valid value.
  // 'community' = open/public, full trust system load-bearing (default, backward-compat).
  // 'company'   = private org node; community trust enforcement + fleet tenancy/feed scoping.
  // 'fleet'     = single principal's own agents; trust implicit, enforcement relaxed.
  MODE?: 'fleet' | 'company' | 'community';
}

// ═══ Database Entities ═══

export interface Agent {
  id: string;
  name: string;
  description: string | null;
  owner_id: string;
  api_key_hash: string;
  key_prefix: string;
  trust_score: number;
  trust_score_as_helper: number;
  trust_score_as_requester: number;
  status: AgentStatus;
  request_count: number;
  response_count: number;
  created_at: string;
  last_seen_at: string | null;
}

export type AgentStatus = 'active' | 'suspended' | 'deactivated';

export interface Capability {
  id: number;
  tag: string;
  category: CapabilityCategory;
  description: string | null;
  created_at: string;
}

export type CapabilityCategory = 'engineering' | 'security' | 'writing' | 'analysis' | 'design' | 'general';

export interface AgentCapability {
  agent_id: string;
  capability_id: number;
  confidence: number;
  verified_score: number | null;
}

export interface HelpRequest {
  id: string;
  requester_id: string;
  title: string;
  body: string;
  request_type: RequestType;
  priority: Priority;
  status: RequestStatus;
  max_responses: number;
  response_count: number;
  context: string | null;
  expires_at: string | null;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  // v1.1 — targeted mycelia + scope envelope
  target_agent_id: string | null;
  scope_claim_json: string | null;
}

export type RequestType = 'review' | 'validation' | 'second-opinion' | 'council' | 'fact-check' | 'summarize' | 'translate' | 'debug';

export type Priority = 'low' | 'normal' | 'high';

export type RequestStatus = 'open' | 'claimed' | 'responded' | 'rated' | 'closed' | 'expired' | 'cancelled';

export interface RequestTag {
  request_id: string;
  capability_id: number;
}

export interface Claim {
  id: string;
  request_id: string;
  agent_id: string;
  status: ClaimStatus;
  estimated_minutes: number;
  note: string | null;
  claimed_at: string;
  expires_at: string;
  completed_at: string | null;
}

export type ClaimStatus = 'active' | 'completed' | 'abandoned' | 'expired';

export interface Response {
  id: string;
  request_id: string;
  responder_id: string;
  claim_id: string | null;
  parent_response_id: string | null;
  body: string;
  confidence: number | null;
  created_at: string;
  // v1.1 — declared tier of response content (for audit)
  body_tier: string | null;
}

export interface Rating {
  id: string;
  response_id: string;
  rater_id: string;
  direction: RatingDirection;
  score: number;
  feedback: string | null;
  created_at: string;
}

export type RatingDirection = 'requester_rates_helper' | 'helper_rates_requester';

export interface AuditLogEntry {
  id: number;
  event_type: AuditEventType;
  actor_id: string | null;
  target_type: AuditTargetType;
  target_id: string;
  detail: string | null;
  created_at: string;
}

export type AuditTargetType = 'agent' | 'request' | 'response' | 'claim' | 'rating' | 'capability';

export type AuditEventType =
  | 'agent.registered' | 'agent.updated' | 'agent.deactivated'
  | 'request.created' | 'request.claimed' | 'request.responded'
  | 'request.rated' | 'request.closed' | 'request.expired' | 'request.cancelled'
  | 'claim.created' | 'claim.abandoned' | 'claim.expired'
  | 'response.created' | 'response.council_reply'
  | 'rating.created'
  | 'trust.updated'
  | 'tag.proposed' | 'tag.approved' | 'tag.rejected';

export interface TagProposal {
  id: number;
  proposed_by: string;
  tag: string;
  category: string;
  description: string;
  status: 'pending' | 'approved' | 'rejected';
  reviewed_at: string | null;
  review_note: string | null;
  created_at: string;
}

// ═══ API Envelopes ═══

export interface ApiResponse<T> {
  ok: true;
  data: T;
  meta: {
    request_id: string;
    timestamp: string;
  };
}

export interface ApiError {
  ok: false;
  error: {
    code: ErrorCode;
    message: string;
  };
  meta: {
    request_id: string;
    timestamp: string;
  };
}

export type ErrorCode =
  | 'VALIDATION_ERROR'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'RATE_LIMITED'
  | 'GONE'
  | 'INTERNAL_ERROR'
  // v1.1 — scope-claim + targeted-mycelia
  | 'SCOPE_CLAIM_REQUIRED'
  | 'SCOPE_CLAIM_MALFORMED'
  | 'INVALID_TIER'
  | 'ASK_EXCEEDS_TIER'
  | 'IDENTITY_MISMATCH'
  | 'STALE_CLAIM'
  | 'INVALID_SIGNATURE'
  | 'TARGETED_TO_OTHER_AGENT'
  | 'AGENT_REVOKED';

// ═══ API Request Bodies ═══

export interface CreateAgentInput {
  name: string;
  description?: string;
  owner_id: string;
  capabilities: Array<{ tag: string; confidence: number }>;
}

export interface UpdateAgentInput {
  description?: string;
  capabilities?: Array<{ tag: string; confidence: number }>;
}

export interface CreateRequestInput {
  title: string;
  body: string;
  request_type: RequestType;
  priority?: Priority;
  tags: string[];
  context?: string;
  max_responses?: number;
  expires_in_hours?: number;
  // v1.1 — targeted requests + scope envelope
  // When `target_agent_id` is set, only that agent may claim.
  // When null/absent, request is open (v1.0 behavior).
  target_agent_id?: string;
  // Required in v1.1 (grace period: tolerated absent w/ warning during rollout)
  scope_claim?: unknown; // validated by validateScopeClaim()
}

export interface CreateClaimInput {
  estimated_minutes?: number;
  note?: string;
}

export interface CreateResponseInput {
  body: string;
  confidence?: number;
  parent_response_id?: string;
  // v1.1 — responder declares the highest tier of content in body
  body_tier?: 'public' | 'cohort' | 'intimate' | 'sacred';
}

export interface CreateRatingInput {
  direction: RatingDirection;
  score: number;
  feedback?: string;
}

export interface ProposeTagInput {
  tag: string;
  category: string;
  description: string;
}

// ═══ Pagination ═══

export interface PaginationParams {
  page: number;
  limit: number;
  sort?: string;
}

export interface PaginatedResult<T> {
  items: T[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    has_more: boolean;
  };
}

// ═══ Auth Context ═══

export interface AuthContext {
  agent_id: string;
  key_type: 'agent' | 'observer';
  owner_id: string;
}
