// src/routes/fleet-bindings.ts
// Service-Bindings RPC bridge — directed-synchronous calls to fleet Workers.
// Step 5 pilot 2026-05-18: only mirror-worker wired. Add others as they ship.
// Spec: docs/specs/WORKER_ENTRYPOINT_SHAPE.md

import { Hono } from 'hono';
import type { Env, AuthContext } from '../types';
import { authMiddleware, requireAgentKey } from '../middleware/auth';
import { rateLimit } from '../middleware/rate-limit';
import { writeAuditLog } from '../lib/audit';
import { validateScopeClaim } from '../lib/scope-claim';
import { success, error } from '../lib/utils';

// Each Service Binding exposes an `ask(scope, question)` method on a typed
// WorkerEntrypoint. We don't redeclare the full Worker types here — we just
// describe the call shape we use.
type AskResult =
  | { ok: true; body: string; body_tier: string; model: string; tokens_used?: number }
  | { ok: false; error: { code: string; message: string } };

interface MirrorBinding {
  ask(scope: unknown, question: string): Promise<AskResult>;
  status(): Promise<{ ok: true; name: string; version: string; model: string; last_seen: string }>;
}

// Extend Env to acknowledge the binding from wrangler.toml [[services]]
type FleetEnv = Env & {
  MIRROR?: MirrorBinding;
  GEMINI?: MirrorBinding;   // Same shape — typed via WORKER_ENTRYPOINT_SHAPE.md
  MISTRAL?: MirrorBinding;
};

const fleet = new Hono<{ Bindings: FleetEnv; Variables: { auth: AuthContext } }>();

fleet.use('*', authMiddleware);
fleet.use('*', requireAgentKey);

// POST /v1/fleet/:agent/ask — call a Worker-backed fleet agent via Service Binding
fleet.post('/:agent/ask', rateLimit('request.create'), async (c) => {
  const auth = c.get('auth');
  const agent = c.req.param('agent').toLowerCase();

  let body: { scope_claim?: unknown; question?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json(error('VALIDATION_ERROR', 'invalid JSON body', 400).body, 400);
  }

  if (typeof body.question !== 'string' || !body.question || body.question.length > 4000) {
    return c.json(error('VALIDATION_ERROR', 'question must be 1-4000 chars', 400).body, 400);
  }

  const v = validateScopeClaim(body.scope_claim, auth.agent_id);
  if (!v.ok) {
    return c.json(error(v.code, v.message, 400).body, 400);
  }

  // Route to the correct binding.
  let result: AskResult;
  let binding: MirrorBinding | undefined;
  switch (agent) {
    case 'mirror':  binding = c.env.MIRROR;  break;
    case 'gemini':  binding = c.env.GEMINI;  break;
    case 'mistral': binding = c.env.MISTRAL; break;
    case 'brook':
      return c.json(
        error('NOT_FOUND', `brook is a Durable Object (different shape — defer to brook-specific design)`, 503).body,
        503
      );
    default:
      return c.json(error('VALIDATION_ERROR', `unknown fleet agent: ${agent}`, 400).body, 400);
  }
  if (!binding) {
    return c.json(error('NOT_FOUND', `${agent} binding not configured`, 503).body, 503);
  }
  try {
    result = await binding.ask(v.claim, body.question);
  } catch (e) {
    return c.json(error('INTERNAL_ERROR', `binding call failed: ${String(e)}`, 502).body, 502);
  }

  // Audit every fleet-binding call
  await writeAuditLog(c.env.DB, c.env.KV, {
    event_type: 'response.created',
    actor_id: auth.agent_id,
    target_type: 'response',
    target_id: `binding-${agent}-${Date.now()}`,
    detail: {
      via: 'service_binding',
      target_agent: agent,
      caller_tier: v.claim.tier,
      ask_max_tier: v.claim.ask_max_tier,
      success: result.ok,
      error_code: result.ok ? null : result.error.code,
    },
  });

  if (!result.ok) {
    return c.json(success({ ok: false, ...result.error, agent }), 200);
  }
  return c.json(
    success({
      ok: true,
      agent,
      via: 'service_binding',
      body: result.body,
      body_tier: result.body_tier,
      model: result.model,
      tokens_used: result.tokens_used,
    }),
    200
  );
});

// GET /v1/fleet/:agent/status — health probe via Service Binding
fleet.get('/:agent/status', async (c) => {
  const agent = c.req.param('agent').toLowerCase();
  let binding: MirrorBinding | undefined;
  switch (agent) {
    case 'mirror':  binding = c.env.MIRROR;  break;
    case 'gemini':  binding = c.env.GEMINI;  break;
    case 'mistral': binding = c.env.MISTRAL; break;
    default:
      return c.json(error('NOT_FOUND', `${agent} binding not configured`, 503).body, 503);
  }
  if (!binding) return c.json(error('NOT_FOUND', `${agent} binding not configured`, 503).body, 503);
  try {
    return c.json(success(await binding.status()));
  } catch (e) {
    return c.json(error('INTERNAL_ERROR', `binding call failed: ${String(e)}`, 502).body, 502);
  }
});

export default fleet;
