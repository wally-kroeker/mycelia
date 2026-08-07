// tests/read-revocation.test.ts
//
// Phase 1 exit-criteria tests: readRevocationCheck middleware.
// Covers all eight rows from the spec's exit-criteria table.
//
// Each test uses app.fetch() + the D1/KV integration harness so the full
// middleware chain runs (auth → rate-limit → readRevocationCheck → handler).

import { describe, it, expect, beforeEach } from 'vitest';
import app from '../src/index';
import {
  applyMigrationsSync,
  createTestEnv,
  createMockKV,
  seedAgents,
  seedDirectedRequest,
  type TestEnv,
  type SeededAgents,
} from './integration/_fixtures';

// ── helpers ──────────────────────────────────────────────────────────────────

function getReq(path: string, key: string): Request {
  return new Request(`http://test.local${path}`, {
    method: 'GET',
    headers: { 'Authorization': `Bearer ${key}` },
  });
}

const REVOCATION_ENTRY = (agentId: string) =>
  JSON.stringify({
    agent_id: agentId,
    reason: 'test revocation',
    revoked_by: 'admin',
    revoked_at: new Date().toISOString(),
    revoke_until: null,
  });

/** Seed KV with a revocation entry for the given agent. */
async function revokeInKv(env: TestEnv, agentId: string): Promise<void> {
  await env.KV.put(`revoke:${agentId}`, REVOCATION_ENTRY(agentId));
}

/** Replace KV.get with a throwing function to simulate a KV outage. */
function makeKvError(env: TestEnv): typeof env {
  return {
    ...env,
    KV: {
      ...env.KV,
      get: async (_key: string) => {
        throw new Error('KV unavailable');
      },
    } as unknown as typeof env.KV,
  };
}

function fleetEnv(env: TestEnv) {
  return { ...env, ENVIRONMENT: 'test', MODE: 'fleet' as const };
}

function communityEnv(env: TestEnv) {
  return { ...env, ENVIRONMENT: 'test', MODE: 'community' as const };
}

// ── setup ─────────────────────────────────────────────────────────────────────

let env: TestEnv;
let agents: SeededAgents;
let requestId: string;

beforeEach(async () => {
  env = createTestEnv();
  applyMigrationsSync(env);
  agents = await seedAgents(env);
  ({ requestId } = await seedDirectedRequest(env, agents));
});

// ── exit-criteria tests ───────────────────────────────────────────────────────

describe('Phase 1 — readRevocationCheck: fleet mode, revoked agent', () => {
  it('GET /v1/requests — revoked agent gets 403 AGENT_REVOKED', async () => {
    await revokeInKv(env, agents.requesterId);
    const res = await app.fetch(getReq('/v1/requests', agents.requesterKey), fleetEnv(env));
    expect(res.status).toBe(403);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe('AGENT_REVOKED');
  });

  it('GET /v1/requests/:id — revoked agent gets 403 AGENT_REVOKED', async () => {
    await revokeInKv(env, agents.requesterId);
    const res = await app.fetch(getReq(`/v1/requests/${requestId}`, agents.requesterKey), fleetEnv(env));
    expect(res.status).toBe(403);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe('AGENT_REVOKED');
  });

  it('GET /v1/capabilities — revoked agent gets 403 AGENT_REVOKED', async () => {
    await revokeInKv(env, agents.requesterId);
    const res = await app.fetch(getReq('/v1/capabilities', agents.requesterKey), fleetEnv(env));
    expect(res.status).toBe(403);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe('AGENT_REVOKED');
  });

  it('GET /v1/feed — revoked agent gets 403 AGENT_REVOKED', async () => {
    await revokeInKv(env, agents.requesterId);
    const res = await app.fetch(getReq('/v1/feed', agents.requesterKey), fleetEnv(env));
    expect(res.status).toBe(403);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe('AGENT_REVOKED');
  });
});

describe('Phase 1 — readRevocationCheck: fleet mode, active agent', () => {
  it('GET /v1/requests — active agent gets 200', async () => {
    const res = await app.fetch(getReq('/v1/requests', agents.requesterKey), fleetEnv(env));
    expect(res.status).toBe(200);
  });
});

describe('Phase 1 — readRevocationCheck: community mode, revoked agent (fail-open)', () => {
  it('GET /v1/requests — community mode: revoked agent passes through (200)', async () => {
    await revokeInKv(env, agents.requesterId);
    const res = await app.fetch(getReq('/v1/requests', agents.requesterKey), communityEnv(env));
    expect(res.status).toBe(200);
  });
});

describe('Phase 1 — readRevocationCheck: KV error behavior', () => {
  it('GET /v1/requests + fleet mode + KV error — 503 INTERNAL_ERROR (fail-closed)', async () => {
    const brokenEnv = makeKvError(env);
    const res = await app.fetch(getReq('/v1/requests', agents.requesterKey), fleetEnv(brokenEnv));
    expect(res.status).toBe(503);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe('INTERNAL_ERROR');
  });

  it('GET /v1/requests + community mode + KV error — 200 (fail-open)', async () => {
    const brokenEnv = makeKvError(env);
    const res = await app.fetch(getReq('/v1/requests', agents.requesterKey), communityEnv(brokenEnv));
    expect(res.status).toBe(200);
  });
});
