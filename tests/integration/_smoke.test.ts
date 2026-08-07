// tests/integration/_smoke.test.ts
// Validates the integration harness itself: D1 adapter, migration runner,
// and agent/request seeders. If this passes, the integration suites can be trusted.
//
// Phase 2 additions: tests for migrations 0006 (widened request_type CHECK +
// capability tag seeding) and 0007 (coordination fields on requests table).

import { describe, it, expect, beforeEach } from 'vitest';
import { applyMigrationsSync, createTestEnv, seedAgents, seedDirectedRequest, TestEnv } from './_fixtures';

describe('integration harness — smoke', () => {
  let env: TestEnv;

  beforeEach(() => {
    env = createTestEnv();
    applyMigrationsSync(env);
  });

  it('applies all seven migrations and exposes the requests table', async () => {
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

  it('migration 0006: ops-bus + lifecycle capability tags seeded', async () => {
    const rows = await env.DB.prepare(
      `SELECT tag, category FROM capabilities WHERE category IN ('ops-bus', 'lifecycle') ORDER BY tag`
    ).all<{ tag: string; category: string }>();
    const tags = rows.results.map((r) => r.tag);
    // ops-bus
    expect(tags).toContain('handoff');
    expect(tags).toContain('collision-warn');
    expect(tags).toContain('status-sync');
    expect(tags).toContain('delegate');
    expect(tags).toContain('blocker');
    // lifecycle
    expect(tags).toContain('ack-close');
    expect(tags).toContain('abandon');
    // verify categories
    const byTag = Object.fromEntries(rows.results.map((r) => [r.tag, r.category]));
    expect(byTag['handoff']).toBe('ops-bus');
    expect(byTag['ack-close']).toBe('lifecycle');
    expect(byTag['abandon']).toBe('lifecycle');
  });

  it('migration 0007: coordination fields present on requests table', async () => {
    const agents = await seedAgents(env);
    const { requestId } = await seedDirectedRequest(env, agents);
    const req = await env.DB.prepare(
      `SELECT references_json, supersedes, artifacts_json, action_required, blocking FROM requests WHERE id = ?`
    ).bind(requestId).first<{
      references_json: string | null;
      supersedes: string | null;
      artifacts_json: string | null;
      action_required: string | null;
      blocking: string | null;
    }>();
    // All nullable; seeder inserts NULL for all except action_required which defaults to 'act' for directed
    expect(req).not.toBeNull();
    expect(req!.action_required).toBe('act');
    expect(req!.references_json).toBeNull();
    expect(req!.supersedes).toBeNull();
    expect(req!.blocking).toBeNull();
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
