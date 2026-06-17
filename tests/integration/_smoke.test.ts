// tests/integration/_smoke.test.ts
// Validates the integration harness itself: D1 adapter, migration runner,
// and agent/request seeders. If this passes, the four regression suites
// can be trusted.

import { describe, it, expect, beforeEach } from 'vitest';
import { applyMigrationsSync, createTestEnv, seedAgents, seedDirectedRequest, TestEnv } from './_fixtures';

describe('integration harness — smoke', () => {
  let env: TestEnv;

  beforeEach(() => {
    env = createTestEnv();
    applyMigrationsSync(env);
  });

  it('applies all three migrations and exposes the requests table', async () => {
    const tables = await env.DB.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`
    ).all<{ name: string }>();
    const names = tables.results.map((r) => r.name);
    expect(names).toContain('requests');
    expect(names).toContain('claims');
    expect(names).toContain('responses');
    expect(names).toContain('agents');
    expect(names).toContain('audit_log');
  });

  it('claims partial unique index (B2 migration) is in place', async () => {
    const idx = await env.DB.prepare(
      `SELECT name, sql FROM sqlite_master WHERE type='index' AND name='idx_claims_request_agent_active'`
    ).first<{ name: string; sql: string }>();
    expect(idx?.name).toBe('idx_claims_request_agent_active');
    expect(idx?.sql).toContain("WHERE status = 'active'");
  });

  it('seeds agents and a directed request', async () => {
    const agents = await seedAgents(env);
    const { requestId } = await seedDirectedRequest(env, agents);

    const req = await env.DB.prepare(`SELECT * FROM requests WHERE id = ?`).bind(requestId).first<any>();
    expect(req.status).toBe('open');
    expect(req.target_agent_id).toBe(agents.responderId);
    expect(req.response_count).toBe(0);
  });

  it('D1Adapter.batch() is atomic — throw rolls back all writes', async () => {
    // INSERT a known row, then attempt a batch where the second statement
    // violates a CHECK constraint. The first INSERT should NOT persist.
    const before = await env.DB.prepare(`SELECT COUNT(*) as c FROM agents`).first<{ c: number }>();
    const ts = new Date().toISOString();
    try {
      await env.DB.batch([
        env.DB.prepare(
          `INSERT INTO agents (id, name, owner_id, api_key_hash, key_prefix, trust_score, status, created_at)
           VALUES ('a-rollback', 'rb', 'owner', 'hash', 'pfx', 0.5, 'active', ?)`
        ).bind(ts),
        // CHECK constraint violation: status must be one of active/suspended/deactivated
        env.DB.prepare(
          `INSERT INTO agents (id, name, owner_id, api_key_hash, key_prefix, trust_score, status, created_at)
           VALUES ('a-invalid', 'inv', 'owner', 'hash2', 'pfx2', 0.5, 'NOT_A_VALID_STATUS', ?)`
        ).bind(ts),
      ]);
      expect.fail('expected batch to throw on CHECK constraint violation');
    } catch (e) {
      // expected
    }
    const after = await env.DB.prepare(`SELECT COUNT(*) as c FROM agents`).first<{ c: number }>();
    expect(after?.c).toBe(before?.c); // rollback: count unchanged
    const orphan = await env.DB.prepare(`SELECT id FROM agents WHERE id = 'a-rollback'`).first();
    expect(orphan).toBeNull();
  });
});
