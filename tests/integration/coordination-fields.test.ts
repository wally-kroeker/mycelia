// tests/integration/coordination-fields.test.ts
//
// v1.2 structured coordination fields on request creation:
//   references[] / supersedes / artifacts[] / action_required / blocking
//
// Arrays persist as JSON strings (references_json / artifacts_json).
// action_required has a smart server default: directed request (target set)
// → 'act', broadcast (no target) → 'fyi', so the triage signal is always
// populated even when the writer omits the field.

import { describe, it, expect, beforeEach } from 'vitest';
import app from '../../src/index';
import {
  applyMigrationsSync,
  createTestEnv,
  seedAgents,
  SeededAgents,
  TestEnv,
} from './_fixtures';

function authReq(path: string, key: string, body?: object, method = 'POST'): Request {
  return new Request(`http://test.local${path}`, {
    method,
    headers: {
      'Authorization': `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

const ENV_EXTRAS = { ENVIRONMENT: 'test', MODE: 'community' as const };

const BASE_BODY = {
  title: 'Coordination fields test',
  body: 'A request body that is at least twenty characters long for the validator.',
  request_type: 'review',
  tags: ['code-review'],
};

interface RequestRow {
  references_json: string | null;
  supersedes: string | null;
  artifacts_json: string | null;
  action_required: string | null;
  blocking: string | null;
  target_agent_id: string | null;
}

describe('v1.2 structured coordination fields', () => {
  let env: TestEnv;
  let agents: SeededAgents;

  beforeEach(async () => {
    env = createTestEnv();
    applyMigrationsSync(env);
    agents = await seedAgents(env);
  });

  async function createRequest(extra: object): Promise<{ status: number; json: any }> {
    const res = await app.fetch(
      authReq('/v1/requests', agents.requesterKey, { ...BASE_BODY, ...extra }),
      { ...env, ...ENV_EXTRAS }
    );
    return { status: res.status, json: await res.json() };
  }

  async function fetchRow(id: string): Promise<RequestRow> {
    const row = await env.DB.prepare(
      `SELECT references_json, supersedes, artifacts_json, action_required, blocking, target_agent_id
       FROM requests WHERE id = ?`
    ).bind(id).first<RequestRow>();
    expect(row).toBeTruthy();
    return row!;
  }

  it('persists all five coordination fields', async () => {
    const { status, json } = await createRequest({
      references: ['req-aaa', 'req-bbb'],
      supersedes: 'req-old',
      artifacts: ['https://example.com/diff.patch', 'abc123def'],
      action_required: 'act',
      blocking: 'req-blocker',
    });
    expect(status).toBe(201);

    const row = await fetchRow(json.data.request.id);
    expect(JSON.parse(row.references_json!)).toEqual(['req-aaa', 'req-bbb']);
    expect(row.supersedes).toBe('req-old');
    expect(JSON.parse(row.artifacts_json!)).toEqual(['https://example.com/diff.patch', 'abc123def']);
    expect(row.action_required).toBe('act');
    expect(row.blocking).toBe('req-blocker');
  });

  it('leaves omitted fields NULL (except defaulted action_required)', async () => {
    const { status, json } = await createRequest({});
    expect(status).toBe(201);

    const row = await fetchRow(json.data.request.id);
    expect(row.references_json).toBeNull();
    expect(row.supersedes).toBeNull();
    expect(row.artifacts_json).toBeNull();
    expect(row.blocking).toBeNull();
    // broadcast (no target) → smart default 'fyi'
    expect(row.action_required).toBe('fyi');
  });

  it("defaults action_required to 'act' for directed requests", async () => {
    const { status, json } = await createRequest({ target_agent_id: agents.responderId });
    expect(status).toBe(201);
    const row = await fetchRow(json.data.request.id);
    expect(row.target_agent_id).toBe(agents.responderId);
    expect(row.action_required).toBe('act');
  });

  it('explicit action_required overrides the smart default', async () => {
    const { status, json } = await createRequest({
      target_agent_id: agents.responderId,
      action_required: 'fyi',
    });
    expect(status).toBe(201);
    const row = await fetchRow(json.data.request.id);
    expect(row.action_required).toBe('fyi');
  });

  it('treats empty arrays as absent (NULL columns)', async () => {
    const { status, json } = await createRequest({ references: [], artifacts: [] });
    expect(status).toBe(201);
    const row = await fetchRow(json.data.request.id);
    expect(row.references_json).toBeNull();
    expect(row.artifacts_json).toBeNull();
  });

  describe('validation rejects malformed input', () => {
    const cases: Array<[string, object]> = [
      ['references not an array', { references: 'req-aaa' }],
      ['references with empty string item', { references: [''] }],
      ['references with non-string item', { references: [42] }],
      ['references over 32 items', { references: Array.from({ length: 33 }, (_, i) => `req-${i}`) }],
      ['references item over 512 chars', { references: ['x'.repeat(513)] }],
      ['artifacts not an array', { artifacts: { url: 'nope' } }],
      ['supersedes empty string', { supersedes: '' }],
      ['supersedes non-string', { supersedes: 7 }],
      ['blocking empty string', { blocking: '' }],
      ['action_required invalid value', { action_required: 'urgent' }],
    ];

    for (const [name, extra] of cases) {
      it(name, async () => {
        const { status, json } = await createRequest(extra);
        expect(status).toBe(400);
        expect(json.error?.code).toBe('VALIDATION_ERROR');
      });
    }
  });

  it('audit log carries the coordination fields', async () => {
    const { status, json } = await createRequest({
      references: ['req-aaa'],
      blocking: 'req-blocker',
    });
    expect(status).toBe(201);

    const audit = await env.DB.prepare(
      `SELECT detail FROM audit_log WHERE event_type = 'request.created' AND target_id = ?`
    ).bind(json.data.request.id).first<{ detail: string }>();
    expect(audit).toBeTruthy();
    const detail = JSON.parse(audit!.detail);
    expect(detail.references).toEqual(['req-aaa']);
    expect(detail.blocking).toBe('req-blocker');
    expect(detail.action_required).toBe('fyi');
  });
});
