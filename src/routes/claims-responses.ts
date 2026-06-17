// src/routes/claims-responses.ts
// Mounted at /v1/requests — paths are relative to that mount point.

import { Hono } from 'hono';
import type { Env, AuthContext, CreateClaimInput, CreateResponseInput, HelpRequest, Claim } from '../types';
import { authMiddleware, requireAgentKey } from '../middleware/auth';
import { rateLimit } from '../middleware/rate-limit';
import { writeAuditLog } from '../lib/audit';
import { success, error, generateId, now } from '../lib/utils';
import { afterClaimCreated, afterResponseSubmitted } from '../models/state-machine';

const claimsResponses = new Hono<{ Bindings: Env; Variables: { auth: AuthContext } }>();

claimsResponses.use('*', authMiddleware);
claimsResponses.use('*', requireAgentKey);

// ─── POST /:id/claims ────────────────────────────────────────────────────────

claimsResponses.post('/:id/claims', rateLimit('claim.create'), async (c) => {
  const auth = c.get('auth');
  const requestId = c.req.param('id');

  let input: CreateClaimInput;
  try {
    input = await c.req.json<CreateClaimInput>();
  } catch {
    input = {};
  }

  // Load the request
  const request = await c.env.DB.prepare(
    'SELECT * FROM requests WHERE id = ?'
  ).bind(requestId).first<HelpRequest>();

  if (!request) {
    return c.json(error('NOT_FOUND', 'Request not found', 404).body, 404);
  }

  // Constraint 1: Cannot claim own request
  if (request.requester_id === auth.agent_id) {
    return c.json(error('FORBIDDEN', 'Cannot claim your own request', 403).body, 403);
  }

  // Constraint 2: Request must not be in a terminal state
  const terminalStates = ['closed', 'expired', 'cancelled'];
  if (terminalStates.includes(request.status)) {
    return c.json(
      error('CONFLICT', `Request is ${request.status} and cannot be claimed`, 409).body,
      409
    );
  }

  // Constraint 3: Request must not be expired
  if (request.expires_at && new Date(request.expires_at) < new Date()) {
    return c.json(error('GONE', 'Request has expired', 410).body, 410);
  }

  // Constraint 4: Request must be under max_responses
  if (request.response_count >= request.max_responses) {
    return c.json(
      error('CONFLICT', 'Request has reached the maximum number of responses', 409).body,
      409
    );
  }

  // Constraint 5: High-priority requires trust_score >= 0.6
  if (request.priority === 'high') {
    const agent = await c.env.DB.prepare(
      'SELECT trust_score FROM agents WHERE id = ?'
    ).bind(auth.agent_id).first<{ trust_score: number }>();

    if ((agent?.trust_score ?? 0) < 0.6) {
      return c.json(
        error('FORBIDDEN', 'High-priority requests require a trust score of at least 0.6', 403).body,
        403
      );
    }
  }

  // Constraint 6: Max 1 active claim per agent per request
  const existingClaim = await c.env.DB.prepare(
    `SELECT id FROM claims WHERE request_id = ? AND agent_id = ? AND status = 'active'`
  ).bind(requestId, auth.agent_id).first<{ id: string }>();

  if (existingClaim) {
    return c.json(
      error('CONFLICT', 'You already have an active claim on this request', 409).body,
      409
    );
  }

  // Constraint 7: Max 5 active claims total per agent
  const activeClaimCount = await c.env.DB.prepare(
    `SELECT COUNT(*) as count FROM claims WHERE agent_id = ? AND status = 'active'`
  ).bind(auth.agent_id).first<{ count: number }>();

  if ((activeClaimCount?.count ?? 0) >= 5) {
    return c.json(
      error('CONFLICT', 'You have reached the maximum of 5 active claims', 409).body,
      409
    );
  }

  // Compute expiry: clamp estimate to [1, 10080], default 60
  const estimatedMinutes = Math.min(Math.max(input.estimated_minutes ?? 60, 1), 10080);
  const claimedAt = now();
  const expiresAt = new Date(
    Date.now() + estimatedMinutes * 1.5 * 60 * 1000
  ).toISOString();

  const claimId = generateId();

  // Compute state-machine transition BEFORE entering the batch. Any throw here
  // (e.g., terminal-status request) bails before any write.
  const newStatus = afterClaimCreated(request.status);

  // Atomic batch: INSERT claim + UPDATE request status. D1's batch() wraps
  // these in an implicit transaction — all succeed or all roll back. Prior
  // implementation ran them as two independent awaits, so a D1 transient
  // error on the UPDATE could leave the claim row committed without the
  // request transitioning to 'claimed'. The agent would then be locked out
  // of re-claiming (constraint 6 detects the active claim) while the
  // request appears unclaimed in the feed — same partial-commit class as B4.
  // Audit log write remains post-batch as best-effort observability.
  await c.env.DB.batch([
    c.env.DB.prepare(`
      INSERT INTO claims (id, request_id, agent_id, estimated_minutes, note, claimed_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).bind(
      claimId,
      requestId,
      auth.agent_id,
      estimatedMinutes,
      input.note ?? null,
      claimedAt,
      expiresAt
    ),
    c.env.DB.prepare(
      'UPDATE requests SET status = ?, updated_at = ? WHERE id = ?'
    ).bind(newStatus, now(), requestId),
  ]);

  try {
    await writeAuditLog(c.env.DB, c.env.KV, {
      event_type: 'request.claimed',
      actor_id: auth.agent_id,
      target_type: 'claim',
      target_id: claimId,
      detail: {
        request_id: requestId,
        estimated_minutes: estimatedMinutes,
        expires_at: expiresAt,
      },
    });
  } catch (auditErr) {
    console.error('[claims] writeAuditLog failed after committed claim', claimId, auditErr);
  }

  return c.json(
    success({
      claim: {
        id: claimId,
        request_id: requestId,
        agent_id: auth.agent_id,
        estimated_minutes: estimatedMinutes,
        note: input.note ?? null,
        status: 'active',
        claimed_at: claimedAt,
        expires_at: expiresAt,
      },
    }),
    201
  );
});

// ─── POST /:id/responses ─────────────────────────────────────────────────────

claimsResponses.post('/:id/responses', rateLimit('response.create'), async (c) => {
  const auth = c.get('auth');
  const requestId = c.req.param('id');

  let input: CreateResponseInput;
  try {
    input = await c.req.json<CreateResponseInput>();
  } catch {
    return c.json(error('VALIDATION_ERROR', 'Request body is required', 400).body, 400);
  }

  // Validate body length (20–50,000 chars)
  if (!input.body || input.body.length < 20) {
    return c.json(
      error('VALIDATION_ERROR', 'Response body must be at least 20 characters', 400).body,
      400
    );
  }
  if (input.body.length > 50000) {
    return c.json(
      error('VALIDATION_ERROR', 'Response body must not exceed 50,000 characters', 400).body,
      400
    );
  }

  // Validate confidence range
  if (input.confidence !== undefined && (input.confidence < 0 || input.confidence > 1)) {
    return c.json(
      error('VALIDATION_ERROR', 'Confidence must be between 0.0 and 1.0', 400).body,
      400
    );
  }

  // Load the request
  const request = await c.env.DB.prepare(
    'SELECT * FROM requests WHERE id = ?'
  ).bind(requestId).first<HelpRequest>();

  if (!request) {
    return c.json(error('NOT_FOUND', 'Request not found', 404).body, 404);
  }

  // Cannot respond to own request
  if (request.requester_id === auth.agent_id) {
    return c.json(
      error('FORBIDDEN', 'Cannot respond to your own request', 403).body,
      403
    );
  }

  // Validate body_tier (enum + sacred refusal + ask_max_tier escalation) BEFORE
  // any claim-state mutation. Prior ordering marked the claim 'completed' first,
  // then ran tier validation — a tier failure left a zombie claim row with no
  // recorded response, and re-claim attempts hit a state-machine 500.
  const validTiers = ['public', 'cohort', 'intimate', 'sacred'] as const;
  const tierRank = { public: 0, cohort: 1, intimate: 2, sacred: 3 } as const;
  const bodyTier = input.body_tier ?? 'public';
  if (!validTiers.includes(bodyTier as any)) {
    return c.json(
      error('VALIDATION_ERROR', `body_tier must be one of: ${validTiers.join(', ')}`, 400).body,
      400
    );
  }
  if (bodyTier === 'sacred') {
    return c.json(
      error(
        'FORBIDDEN',
        'sacred-tier content cannot be transmitted over mycelia; direct Rob session required',
        403
      ).body,
      403
    );
  }
  if (request.scope_claim_json) {
    try {
      const reqScope = JSON.parse(request.scope_claim_json) as { ask_max_tier?: string };
      const askMax = reqScope.ask_max_tier as keyof typeof tierRank | undefined;
      if (askMax && askMax in tierRank && tierRank[bodyTier as keyof typeof tierRank] > tierRank[askMax]) {
        return c.json(
          error(
            'ASK_EXCEEDS_TIER',
            `Response body_tier (${bodyTier}) exceeds requester's ask_max_tier (${askMax}). Tier escalation refused server-side.`,
            403
          ).body,
          403
        );
      }
    } catch {
      // malformed scope_claim_json — let the response through (legacy grace)
    }
  }

  let claimId: string | null = null;
  const isCouncilFollowUp =
    request.request_type === 'council' && !!input.parent_response_id;

  if (isCouncilFollowUp) {
    // Council follow-up: verify parent response exists in this request
    const parent = await c.env.DB.prepare(
      'SELECT id FROM responses WHERE id = ? AND request_id = ?'
    ).bind(input.parent_response_id, requestId).first<{ id: string }>();

    if (!parent) {
      return c.json(
        error('NOT_FOUND', 'Parent response not found in this request', 404).body,
        404
      );
    }
    // claimId stays null — council follow-ups do not require an exclusive claim
  } else {
    // Standard response: must have an active, non-expired claim
    const claim = await c.env.DB.prepare(
      `SELECT id, expires_at FROM claims
       WHERE request_id = ? AND agent_id = ? AND status = 'active'`
    ).bind(requestId, auth.agent_id).first<Pick<Claim, 'id' | 'expires_at'>>();

    if (!claim) {
      return c.json(
        error('FORBIDDEN', 'You must have an active claim on this request to respond', 403).body,
        403
      );
    }

    if (new Date(claim.expires_at) < new Date()) {
      return c.json(error('GONE', 'Your claim has expired', 410).body, 410);
    }

    claimId = claim.id;
  }

  const responseId = generateId();
  const createdAt = now();

  // Compute state-machine transition BEFORE entering the batch. Any throw here
  // (e.g., terminal-status request) bails before any write, so no partial commit.
  const newStatus = afterResponseSubmitted(request.status);

  // Atomic batch: mark claim completed + INSERT response + UPDATE request +
  // UPDATE agent. D1's batch() wraps all of these in an implicit transaction —
  // all succeed or all roll back. Including the claim-mark-completed in the
  // batch (rather than as a separate await prior to the batch) means an
  // INSERT-response failure cannot leave the claim zombied (the original B1
  // surface) and also cannot leave request/agent counters diverging from
  // response_count (the original B4 surface). Audit log writes remain
  // post-batch as best-effort observability.
  const batchStatements = [
    c.env.DB.prepare(`
      INSERT INTO responses (id, request_id, responder_id, claim_id, parent_response_id, body, confidence, created_at, body_tier)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      responseId,
      requestId,
      auth.agent_id,
      claimId,
      input.parent_response_id ?? null,
      input.body,
      input.confidence ?? null,
      createdAt,
      bodyTier
    ),
    c.env.DB.prepare(
      'UPDATE requests SET status = ?, response_count = response_count + 1, updated_at = ? WHERE id = ?'
    ).bind(newStatus, now(), requestId),
    c.env.DB.prepare(
      'UPDATE agents SET response_count = response_count + 1 WHERE id = ?'
    ).bind(auth.agent_id),
  ];
  if (claimId) {
    batchStatements.unshift(
      c.env.DB.prepare(
        `UPDATE claims SET status = 'completed', completed_at = ? WHERE id = ?`
      ).bind(now(), claimId)
    );
  }
  await c.env.DB.batch(batchStatements);

  // Audit log writes happen after the batch commits. If audit throws, the
  // response is already durable — we don't roll back user-visible work for
  // an observability failure. Errors logged for later inspection.
  try {
    const eventType = isCouncilFollowUp ? 'response.council_reply' : 'response.created';
    await writeAuditLog(c.env.DB, c.env.KV, {
      event_type: eventType,
      actor_id: auth.agent_id,
      target_type: 'response',
      target_id: responseId,
      detail: {
        request_id: requestId,
        claim_id: claimId,
        parent_response_id: input.parent_response_id ?? null,
        body_tier: bodyTier,
        request_target_agent_id: request.target_agent_id,
      },
    });
  } catch (auditErr) {
    console.error('[responses] writeAuditLog failed after committed response', responseId, auditErr);
  }

  return c.json(
    success({
      response: {
        id: responseId,
        request_id: requestId,
        responder_id: auth.agent_id,
        claim_id: claimId,
        parent_response_id: input.parent_response_id ?? null,
        confidence: input.confidence ?? null,
        created_at: createdAt,
      },
    }),
    201
  );
});

export default claimsResponses;
