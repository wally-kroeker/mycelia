// tests/integration/_fixtures.ts
//
// Per-test environment: better-sqlite3 D1 adapter + mock KV + seeded agents
// and requests. Returns an `env` object that handlers' `c.env` expects.
//
// Migration SQL is imported as raw text via Vite's ?raw — bundled at test
// transform time so no fs access is needed at runtime.

import migration0001 from '../../migrations/0001_initial.sql?raw';
import migration0002 from '../../migrations/0002_targeted_mycelia.sql?raw';
import migration0003 from '../../migrations/0003_partial_unique_claim_active.sql?raw';
import migration0004 from '../../migrations/0004_rate_limits_d1.sql?raw';
import migration0005 from '../../migrations/0005_tier_rename_personal_sealed.sql?raw';
import migration0006 from '../../migrations/0006_widen_request_type_ops_bus.sql?raw';
import migration0007 from '../../migrations/0007_add_structured_coordination_fields.sql?raw';
import migration0008 from '../../migrations/0008_agent_tier.sql?raw';
import migration0009 from '../../migrations/0009_lifecycle_mechanics.sql?raw';
import { createD1Test, D1Adapter } from './_d1-adapter';

// All nine migrations applied in sequence.
// Phase 3 adds migration 0008 (agent_tier). Phase 4 adds migration 0009 (lifecycle mechanics).
const MIGRATIONS = [migration0001, migration0002, migration0003, migration0004, migration0005, migration0006, migration0007, migration0008, migration0009];

export function createMockKV() {
  const store = new Map<string, string>();
  return {
    async get(key: string): Promise<string | null> {
      return store.get(key) ?? null;
    },
    async put(key: string, value: string): Promise<void> {
      store.set(key, value);
    },
    async delete(key: string): Promise<void> {
      store.delete(key);
    },
    async list({ prefix }: { prefix?: string } = {}): Promise<{ keys: Array<{ name: string }> }> {
      const keys = Array.from(store.keys())
        .filter((k) => (prefix ? k.startsWith(prefix) : true))
        .map((name) => ({ name }));
      return { keys };
    },
  };
}

function splitSql(sql: string): string[] {
  const cleaned = sql
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n');
  return cleaned
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export interface TestEnv {
  DB: D1Adapter;
  KV: ReturnType<typeof createMockKV>;
}

export function applyMigrationsSync(env: TestEnv): void {
  const db = env.DB.db;
  for (const sql of MIGRATIONS) {
    for (const stmt of splitSql(sql)) {
      db.exec(stmt);
    }
  }
}

export interface SeededAgents {
  requesterId: string;
  requesterKey: string;
  responderId: string;
  responderKey: string;
}

export async function seedAgents(
  env: TestEnv,
  options: { tier?: 'peer' | 'trusted' } = {}
): Promise<SeededAgents> {
  const requesterId = 'agent-requester-' + crypto.randomUUID();
  const responderId = 'agent-responder-' + crypto.randomUUID();
  const requesterKey = 'mycelia_live_' + 'a'.repeat(64);
  const responderKey = 'mycelia_live_' + 'b'.repeat(64);
  const requesterHash = await sha256(requesterKey);
  const responderHash = await sha256(responderKey);
  // Auth middleware computes prefix as:
  // key.substring(0, key.indexOf('_', key.indexOf('_') + 1) + 1 + 8)
  // For 'mycelia_live_aaaa...' that's chars [0..21) → 'mycelia_live_aaaaaaaa'
  const requesterPrefix = requesterKey.substring(0, 21);
  const responderPrefix = responderKey.substring(0, 21);
  const ts = new Date().toISOString();
  const tier = options.tier ?? 'peer';

  for (const [id, prefix, hash] of [
    [requesterId, requesterPrefix, requesterHash],
    [responderId, responderPrefix, responderHash],
  ]) {
    await env.DB.prepare(
      `INSERT INTO agents (id, name, owner_id, api_key_hash, key_prefix, trust_score, status, agent_tier, created_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(id, 'test-agent-' + id.slice(-8), 'owner-test', hash, prefix, 0.7, 'active', tier, ts, ts).run();
  }

  return { requesterId, requesterKey, responderId, responderKey };
}

export interface SeededRequest {
  requestId: string;
}

export async function seedDirectedRequest(
  env: TestEnv,
  agents: SeededAgents,
  options: {
    askMaxTier?: 'public' | 'cohort' | 'personal';
    status?: string;
    request_type?: string;
    action_required?: 'fyi' | 'act';
  } = {}
): Promise<SeededRequest> {
  const requestId = 'req-' + crypto.randomUUID();
  const ts = new Date().toISOString();
  const askMaxTier = options.askMaxTier ?? 'public';
  const status = options.status ?? 'open';
  const request_type = options.request_type ?? 'second-opinion';
  const action_required = options.action_required ?? 'act';
  const scopeClaim = JSON.stringify({
    requester: 'test',
    agent_id: agents.requesterId,
    tier: askMaxTier,
    ask_max_tier: askMaxTier,
    ts,
  });

  await env.DB.prepare(
    `INSERT INTO requests (
      id, requester_id, title, body, request_type, priority, status, max_responses,
      response_count, expires_at, created_at, updated_at, target_agent_id, scope_claim_json,
      action_required
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    requestId,
    agents.requesterId,
    'Integration test request',
    'A request body that is at least twenty characters long for the validator.',
    request_type,
    'normal',
    status,
    3,
    0,
    new Date(Date.now() + 3600 * 1000).toISOString(),
    ts,
    ts,
    agents.responderId,
    scopeClaim,
    action_required
  ).run();

  return { requestId };
}

export function createTestEnv(): TestEnv {
  const { adapter } = createD1Test();
  return { DB: adapter, KV: createMockKV() };
}

async function sha256(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
