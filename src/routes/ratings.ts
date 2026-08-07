// src/routes/ratings.ts
// Mounted at /v1/responses in index.ts — exposes POST /:id/ratings

import { Hono } from 'hono';
import type { Env, AuthContext, CreateRatingInput } from '../types';
import { authMiddleware, requireAgentKey } from '../middleware/auth';
import { rateLimit } from '../middleware/rate-limit';
import { writeAuditLog } from '../lib/audit';
import { success, error, generateId, now } from '../lib/utils';
import { calculateCapabilityTrust, calculateGlobalTrust } from '../models/trust';
import { afterRatingSubmitted, InvalidTransitionError } from '../models/state-machine';

const ratings = new Hono<{ Bindings: Env; Variables: { auth: AuthContext } }>();

ratings.use('*', authMiddleware);
ratings.use('*', requireAgentKey);

// POST /v1/responses/:id/ratings — bidirectional rating
ratings.post('/:id/ratings', rateLimit('rating.create'), async (c) => {
  const auth = c.get('auth');
  const responseId = c.req.param('id');

  let input: CreateRatingInput;
  try {
    input = await c.req.json<CreateRatingInput>();
  } catch {
    return c.json(error('VALIDATION_ERROR', 'Invalid JSON body', 400).body, 400);
  }

  // Validate required fields
  if (!input.direction || !['requester_rates_helper', 'helper_rates_requester'].includes(input.direction)) {
    return c.json(
      error('VALIDATION_ERROR', 'direction must be requester_rates_helper or helper_rates_requester', 400).body,
      400
    );
  }
  // score is required for standard ratings (ack-close ratings are created by the server)
  if (typeof input.score !== 'number' || !Number.isInteger(input.score) || input.score < 1 || input.score > 5) {
    return c.json(error('VALIDATION_ERROR', 'score must be an integer between 1 and 5', 400).body, 400);
  }

  // Fetch response + request context in one query
  const response = await c.env.DB.prepare(`
    SELECT
      resp.id,
      resp.responder_id,
      resp.request_id,
      r.requester_id,
      r.status AS request_status
    FROM responses resp
    JOIN requests r ON resp.request_id = r.id
    WHERE resp.id = ?
  `).bind(responseId).first<{
    id: string;
    responder_id: string;
    request_id: string;
    requester_id: string;
    request_status: string;
  }>();

  if (!response) {
    return c.json(error('NOT_FOUND', 'Response not found', 404).body, 404);
  }

  // Direction validation — who is allowed to rate in which direction
  if (input.direction === 'requester_rates_helper') {
    if (auth.agent_id !== response.requester_id) {
      return c.json(
        error('FORBIDDEN', 'Only the original requester can rate in direction requester_rates_helper', 403).body,
        403
      );
    }
  } else {
    // helper_rates_requester
    if (auth.agent_id !== response.responder_id) {
      return c.json(
        error('FORBIDDEN', 'Only the responder can rate in direction helper_rates_requester', 403).body,
        403
      );
    }
  }

  // Determine rated agent id based on direction
  const ratedAgentId =
    input.direction === 'requester_rates_helper'
      ? response.responder_id   // requester is rating the helper
      : response.requester_id;  // helper is rating the requester

  // Anti-gaming: fetch both agents' owner_id and compare
  const [raterAgent, ratedAgent] = await Promise.all([
    c.env.DB.prepare('SELECT owner_id FROM agents WHERE id = ?')
      .bind(auth.agent_id)
      .first<{ owner_id: string }>(),
    c.env.DB.prepare('SELECT owner_id FROM agents WHERE id = ?')
      .bind(ratedAgentId)
      .first<{ owner_id: string }>(),
  ]);

  if (!raterAgent || !ratedAgent) {
    return c.json(error('INTERNAL_ERROR', 'Could not verify agent ownership', 500).body, 500);
  }

  if (raterAgent.owner_id === ratedAgent.owner_id) {
    return c.json(
      error('FORBIDDEN', 'Agents sharing the same owner_id cannot rate each other', 403).body,
      403
    );
  }

  // Duplicate check — unique on (response_id, rater_id, direction)
  const existing = await c.env.DB.prepare(
    'SELECT id FROM ratings WHERE response_id = ? AND rater_id = ? AND direction = ?'
  ).bind(responseId, auth.agent_id, input.direction).first<{ id: string }>();

  if (existing) {
    return c.json(error('CONFLICT', 'You have already submitted a rating in this direction', 409).body, 409);
  }

  // cross_owner: computed from DB join — rater vs. rated agent.
  // The anti-gaming check above already verified both agents; reuse the result.
  // 1 = different owner (cross-owner, feeds community trust)
  // 0 = same owner — blocked above, so this will always be 1 here, but computed
  //     explicitly from the join result to match the contract (never from AuthContext).
  const crossOwner: 0 | 1 = raterAgent.owner_id !== ratedAgent.owner_id ? 1 : 0;

  // Insert rating
  const ratingId = generateId();
  const createdAt = now();

  await c.env.DB.prepare(`
    INSERT INTO ratings (id, response_id, rater_id, direction, score, feedback, created_at, cross_owner, source_type)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'standard')
  `).bind(
    ratingId,
    responseId,
    auth.agent_id,
    input.direction,
    input.score,
    input.feedback ?? null,
    createdAt,
    crossOwner
  ).run();

  // Recalculate trust scores for the rated agent
  await recalculateTrust(c.env.DB, ratedAgentId, input.direction);

  // Transition request status (responded → rated, or rated → rated)
  try {
    const newStatus = afterRatingSubmitted(response.request_status as any);
    await c.env.DB.prepare(
      'UPDATE requests SET status = ?, updated_at = ? WHERE id = ?'
    ).bind(newStatus, now(), response.request_id).run();
  } catch (err) {
    if (!(err instanceof InvalidTransitionError)) {
      // Unexpected error — surface it
      return c.json(error('INTERNAL_ERROR', 'Failed to transition request status', 500).body, 500);
    }
    // InvalidTransitionError is tolerated — rating still recorded even if status
    // is already in a terminal state (e.g. closed).
  }

  // Audit log for rating.created
  await writeAuditLog(c.env.DB, c.env.KV, {
    event_type: 'rating.created',
    actor_id: auth.agent_id,
    target_type: 'rating',
    target_id: ratingId,
    detail: {
      response_id: responseId,
      direction: input.direction,
      score: input.score,
      rated_agent_id: ratedAgentId,
    },
  });

  // Audit log for trust.updated (separate entry per spec)
  await writeAuditLog(c.env.DB, c.env.KV, {
    event_type: 'trust.updated',
    actor_id: null,
    target_type: 'agent',
    target_id: ratedAgentId,
    detail: {
      triggered_by: 'rating.created',
      rating_id: ratingId,
      direction: input.direction,
    },
  });

  return c.json(success({ rating: { id: ratingId } }), 201);
});

// ─── Trust Recalculation ─────────────────────────────────────────────────────

/**
 * Recalculate per-capability and global trust for an agent after a new rating.
 *
 * Steps:
 *  1. Get all capabilities the agent has declared.
 *  2. For each capability, collect all requester_rates_helper scores on responses
 *     to requests tagged with that capability.
 *  3. Compute Wilson score → update agent_capabilities.verified_score.
 *  4. Compute weighted global trust → update agents.trust_score and the
 *     directional field (trust_score_as_helper | trust_score_as_requester).
 */
async function recalculateTrust(
  db: D1Database,
  agentId: string,
  direction: string
): Promise<void> {
  // Step 1: get all capability ids for this agent
  const capabilitiesResult = await db
    .prepare('SELECT capability_id FROM agent_capabilities WHERE agent_id = ?')
    .bind(agentId)
    .all<{ capability_id: number }>();

  const capabilityScores: Array<{ score: number | null; ratingCount: number }> = [];

  // Step 2 & 3: per-capability Wilson score
  for (const cap of capabilitiesResult.results) {
    // Collect all requester_rates_helper ratings for this agent on responses
    // to requests that carry this capability tag.
    const ratingsResult = await db
      .prepare(`
        SELECT rat.score
        FROM ratings rat
        JOIN responses resp ON rat.response_id = resp.id
        JOIN request_tags rt ON resp.request_id = rt.request_id
        WHERE resp.responder_id = ?
          AND rt.capability_id = ?
          AND rat.direction = 'requester_rates_helper'
          AND rat.cross_owner = 1
          AND rat.score IS NOT NULL
      `)
      .bind(agentId, cap.capability_id)
      .all<{ score: number }>();

    const scores = ratingsResult.results.map((r) => r.score);
    const trustScore = calculateCapabilityTrust(scores);

    // Update verified_score when we have at least one rating
    if (trustScore !== null) {
      await db
        .prepare(
          'UPDATE agent_capabilities SET verified_score = ? WHERE agent_id = ? AND capability_id = ?'
        )
        .bind(trustScore, agentId, cap.capability_id)
        .run();
    }

    capabilityScores.push({ score: trustScore, ratingCount: scores.length });
  }

  // Step 4: global trust
  const globalTrust = calculateGlobalTrust(capabilityScores);

  // Update the directional field and the overall trust_score
  const trustField =
    direction === 'requester_rates_helper'
      ? 'trust_score_as_helper'
      : 'trust_score_as_requester';

  await db
    .prepare(
      `UPDATE agents SET ${trustField} = ?, trust_score = ?, last_seen_at = ? WHERE id = ?`
    )
    .bind(globalTrust, globalTrust, now(), agentId)
    .run();
}

export default ratings;
