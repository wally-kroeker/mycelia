// tests/fleet-mode.test.ts
// Unit tests for the three-mode MODE flag (P6 Phase 1).
// One test per feature-matrix row, per mode — pure-function helpers only.
// Route-level integration (DB, KV, HTTP) is a follow-on once a test D1 fixture is wired.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  validateMode,
  isRegistrationRestricted,
  isTrustGateRelaxed,
  isScopeClaimEnforced,
  isFeedScoped,
  isKvFailClosed,
  isReadRevocationEnforced,
  registrationGate,
  checkRevocationWithMode,
  type NodeMode,
} from '../src/middleware/fleet-gate';
import type { Env } from '../src/types';

// ═══ validateMode ════════════════════════════════════════════════════════════

describe('validateMode — startup validation', () => {
  it('accepts fleet', () => {
    expect(validateMode({ MODE: 'fleet' } as Env)).toBe('fleet');
  });

  it('accepts company', () => {
    expect(validateMode({ MODE: 'company' } as Env)).toBe('company');
  });

  it('accepts community', () => {
    expect(validateMode({ MODE: 'community' } as Env)).toBe('community');
  });

  it('throws on unset MODE — fail-closed', () => {
    expect(() => validateMode({} as Env)).toThrow(/invalid or missing MODE/i);
  });

  it('throws on invalid MODE value — fail-closed', () => {
    expect(() => validateMode({ MODE: 'public' as NodeMode } as Env)).toThrow(/invalid or missing MODE/i);
  });

  it('throws on empty string — fail-closed', () => {
    expect(() => validateMode({ MODE: '' as NodeMode } as Env)).toThrow(/invalid or missing MODE/i);
  });
});

// ═══ Feature matrix — registration gate ══════════════════════════════════════

describe('isRegistrationRestricted — registration gate', () => {
  it('fleet: restricted', () => expect(isRegistrationRestricted('fleet')).toBe(true));
  it('company: restricted', () => expect(isRegistrationRestricted('company')).toBe(true));
  it('community: open', () => expect(isRegistrationRestricted('community')).toBe(false));
});

// ═══ Feature matrix — trust gate ══════════════════════════════════════════════

describe('isTrustGateRelaxed — ≥0.6 high-priority requirement', () => {
  it('fleet: relaxed (trust implicit — revocation is the control)', () => {
    expect(isTrustGateRelaxed('fleet')).toBe(true);
  });
  it('company: load-bearing (trust is managed, not implicit)', () => {
    expect(isTrustGateRelaxed('company')).toBe(false);
  });
  it('community: load-bearing (trust is earned)', () => {
    expect(isTrustGateRelaxed('community')).toBe(false);
  });
});

// ═══ Feature matrix — scope-claim enforcement ═════════════════════════════════

describe('isScopeClaimEnforced — scope-claim grace period', () => {
  it('fleet: enforced (grace period closed)', () => {
    expect(isScopeClaimEnforced('fleet')).toBe(true);
  });
  it('company: enforced (private node, identity envelope always expected)', () => {
    expect(isScopeClaimEnforced('company')).toBe(true);
  });
  it('community: grace period active', () => {
    expect(isScopeClaimEnforced('community')).toBe(false);
  });
});

// ═══ Feature matrix — feed visibility scoping ════════════════════════════════

describe('isFeedScoped — feed visibility', () => {
  it('fleet: scoped to owner', () => expect(isFeedScoped('fleet')).toBe(true));
  it('company: scoped to owner', () => expect(isFeedScoped('company')).toBe(true));
  it('community: global feed', () => expect(isFeedScoped('community')).toBe(false));
});

// ═══ Feature matrix — KV fail behavior ══════════════════════════════════════

describe('isKvFailClosed — KV error handling', () => {
  it('fleet: fail-closed (KV outage must not bypass revocation)', () => {
    expect(isKvFailClosed('fleet')).toBe(true);
  });
  it('company: fail-closed (private node; same security posture as fleet)', () => {
    expect(isKvFailClosed('company')).toBe(true);
  });
  it('community: fail-open (KV outage should not take down the network)', () => {
    expect(isKvFailClosed('community')).toBe(false);
  });
});

// ═══ Feature matrix — read revocation enforcement ════════════════════════════

describe('isReadRevocationEnforced — read-bypass gap', () => {
  it('fleet: reads enforce revocation', () => {
    expect(isReadRevocationEnforced('fleet')).toBe(true);
  });
  it('company: reads enforce revocation', () => {
    expect(isReadRevocationEnforced('company')).toBe(true);
  });
  it('community: reads skip revocation check (current behavior)', () => {
    expect(isReadRevocationEnforced('community')).toBe(false);
  });
});

// ═══ Mode combinations — company is community-trust + fleet-tenancy ══════════

describe('company mode — community trust enforcement + fleet tenancy scoping', () => {
  it('registration: restricted (fleet column)', () => {
    expect(isRegistrationRestricted('company')).toBe(true);
  });
  it('feed: scoped (fleet column)', () => {
    expect(isFeedScoped('company')).toBe(true);
  });
  it('KV fail: closed (fleet column)', () => {
    expect(isKvFailClosed('company')).toBe(true);
  });
  it('trust gate: load-bearing (community column)', () => {
    expect(isTrustGateRelaxed('company')).toBe(false);
  });
  it('scope-claim: enforced (community column — strict)', () => {
    expect(isScopeClaimEnforced('company')).toBe(true);
  });
});

// ═══ registrationGate middleware ══════════════════════════════════════════════

describe('registrationGate middleware', () => {
  function makeContext(mode: string | undefined) {
    const responses: Array<[unknown, number | undefined]> = [];
    return {
      env: { MODE: mode } as Env,
      json: (body: unknown, status?: number) => {
        responses.push([body, status]);
        return new Response(JSON.stringify(body), { status: status ?? 200 });
      },
      _responses: responses,
    };
  }

  it('fleet: returns 403 and does not call next', async () => {
    const ctx = makeContext('fleet');
    let nextCalled = false;
    await registrationGate(ctx as Parameters<typeof registrationGate>[0], async () => { nextCalled = true; });
    expect(ctx._responses[0]?.[1]).toBe(403);
    expect(nextCalled).toBe(false);
  });

  it('company: returns 403 and does not call next', async () => {
    const ctx = makeContext('company');
    let nextCalled = false;
    await registrationGate(ctx as Parameters<typeof registrationGate>[0], async () => { nextCalled = true; });
    expect(ctx._responses[0]?.[1]).toBe(403);
    expect(nextCalled).toBe(false);
  });

  it('community: calls next (no-op)', async () => {
    const ctx = makeContext('community');
    let nextCalled = false;
    await registrationGate(ctx as Parameters<typeof registrationGate>[0], async () => { nextCalled = true; });
    expect(ctx._responses).toHaveLength(0);
    expect(nextCalled).toBe(true);
  });

  it('undefined MODE: treated as community (defensive default)', async () => {
    // MODE is optional in Env — defensive fallback to community allows backward-compat
    const ctx = makeContext(undefined);
    let nextCalled = false;
    await registrationGate(ctx as Parameters<typeof registrationGate>[0], async () => { nextCalled = true; });
    expect(nextCalled).toBe(true);
  });
});

// ═══ checkRevocationWithMode ══════════════════════════════════════════════════

describe('checkRevocationWithMode — mode-aware revocation', () => {
  function makeKv(result: 'not-revoked' | 'revoked' | 'error'): KVNamespace {
    return {
      get: async (_key: string) => {
        if (result === 'error') throw new Error('KV unavailable');
        if (result === 'revoked') {
          return JSON.stringify({
            agent_id: 'agt_test',
            reason: 'test revocation',
            revoked_by: 'admin',
            revoked_at: new Date().toISOString(),
            revoke_until: null,
          });
        }
        return null;
      },
      delete: async () => {},
      put: async () => {},
      list: async () => ({ keys: [], list_complete: true, cursor: undefined }),
      getWithMetadata: async () => ({ value: null, metadata: null }),
    } as unknown as KVNamespace;
  }

  it('not-revoked: returns { revoked: false } in all modes', async () => {
    for (const mode of ['fleet', 'company', 'community'] as NodeMode[]) {
      const result = await checkRevocationWithMode(makeKv('not-revoked'), 'agt_test', mode);
      expect(result).toMatchObject({ revoked: false });
    }
  });

  it('revoked: returns { revoked: true, entry } in all modes', async () => {
    for (const mode of ['fleet', 'company', 'community'] as NodeMode[]) {
      const result = await checkRevocationWithMode(makeKv('revoked'), 'agt_test', mode);
      expect(result).toMatchObject({ revoked: true });
      expect('entry' in result && result.revoked).toBe(true);
    }
  });

  it('KV error + fleet: re-throws (caller must return 503)', async () => {
    await expect(
      checkRevocationWithMode(makeKv('error'), 'agt_test', 'fleet')
    ).rejects.toThrow('KV unavailable');
  });

  it('KV error + company: re-throws (caller must return 503)', async () => {
    await expect(
      checkRevocationWithMode(makeKv('error'), 'agt_test', 'company')
    ).rejects.toThrow('KV unavailable');
  });

  it('KV error + community: returns { revoked: false, kvError: true } (fail-open)', async () => {
    const result = await checkRevocationWithMode(makeKv('error'), 'agt_test', 'community');
    expect(result).toMatchObject({ revoked: false });
  });
});
