// tests/scope-claim.test.ts
// Tests for the v1.1 scope-claim validator.

import { describe, it, expect } from 'vitest';
import {
  validateScopeClaim,
  permits,
  compareTiers,
  refusalRequiredForMycelia,
  buildScopeClaim,
} from '../src/lib/scope-claim';

const NOW = Date.parse('2026-05-18T18:00:00Z');
const FRESH_TS = '2026-05-18T17:30:00Z'; // 30 min before NOW
const STALE_TS = '2026-05-18T16:30:00Z'; // 90 min before NOW (stale)

describe('validateScopeClaim', () => {
  const validClaim = {
    requester: 'leroy',
    agent_id: 'pai-leroy-mn4ol0k6',
    tier: 'cohort',
    ask_max_tier: 'cohort',
    ts: FRESH_TS,
  };

  it('accepts a valid claim', () => {
    const r = validateScopeClaim(validClaim, 'pai-leroy-mn4ol0k6', NOW);
    expect(r.ok).toBe(true);
  });

  it('rejects null', () => {
    const r = validateScopeClaim(null, 'pai-leroy-mn4ol0k6', NOW);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('SCOPE_CLAIM_REQUIRED');
  });

  it('rejects non-object', () => {
    const r = validateScopeClaim('not-an-object', 'pai-leroy-mn4ol0k6', NOW);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('SCOPE_CLAIM_MALFORMED');
  });

  it('rejects missing requester', () => {
    const r = validateScopeClaim({ ...validClaim, requester: '' }, 'pai-leroy-mn4ol0k6', NOW);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('SCOPE_CLAIM_MALFORMED');
  });

  it('rejects invalid tier', () => {
    const r = validateScopeClaim({ ...validClaim, tier: 'classified' }, 'pai-leroy-mn4ol0k6', NOW);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('INVALID_TIER');
  });

  it('rejects ask_max_tier > tier', () => {
    const r = validateScopeClaim(
      { ...validClaim, tier: 'public', ask_max_tier: 'sacred' },
      'pai-leroy-mn4ol0k6',
      NOW,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('ASK_EXCEEDS_TIER');
  });

  it('allows ask_max_tier < tier', () => {
    const r = validateScopeClaim(
      { ...validClaim, tier: 'sacred', ask_max_tier: 'public' },
      'pai-leroy-mn4ol0k6',
      NOW,
    );
    expect(r.ok).toBe(true);
  });

  it('rejects identity mismatch', () => {
    const r = validateScopeClaim(validClaim, 'pai-someone-else', NOW);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('IDENTITY_MISMATCH');
  });

  it('skips identity check when bearerAgentId is null', () => {
    const r = validateScopeClaim(validClaim, null, NOW);
    expect(r.ok).toBe(true);
  });

  it('rejects stale ts (>1h old)', () => {
    const r = validateScopeClaim({ ...validClaim, ts: STALE_TS }, 'pai-leroy-mn4ol0k6', NOW);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('STALE_CLAIM');
  });

  it('rejects unparseable ts', () => {
    const r = validateScopeClaim({ ...validClaim, ts: 'not-a-date' }, 'pai-leroy-mn4ol0k6', NOW);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('SCOPE_CLAIM_MALFORMED');
  });

  it('preserves optional signature field', () => {
    const r = validateScopeClaim(
      { ...validClaim, signature: 'ed25519:abcdef' },
      'pai-leroy-mn4ol0k6',
      NOW,
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.claim.signature).toBe('ed25519:abcdef');
  });
});

describe('permits', () => {
  it('permits same tier', () => {
    expect(permits('cohort', 'cohort')).toBe(true);
  });
  it('permits higher tier reading lower', () => {
    expect(permits('sacred', 'public')).toBe(true);
    expect(permits('intimate', 'cohort')).toBe(true);
  });
  it('denies lower tier reading higher', () => {
    expect(permits('public', 'cohort')).toBe(false);
    expect(permits('cohort', 'sacred')).toBe(false);
  });
});

describe('compareTiers', () => {
  it('orders correctly', () => {
    expect(compareTiers('public', 'cohort')).toBeLessThan(0);
    expect(compareTiers('cohort', 'cohort')).toBe(0);
    expect(compareTiers('sacred', 'public')).toBeGreaterThan(0);
  });
});

describe('refusalRequiredForMycelia', () => {
  it('only refuses sacred', () => {
    expect(refusalRequiredForMycelia('sacred')).toBe(true);
    expect(refusalRequiredForMycelia('intimate')).toBe(false);
    expect(refusalRequiredForMycelia('cohort')).toBe(false);
    expect(refusalRequiredForMycelia('public')).toBe(false);
  });
});

describe('buildScopeClaim', () => {
  it('defaults ask_max_tier to tier', () => {
    const c = buildScopeClaim({
      requesterName: 'leroy',
      agentId: 'pai-leroy-mn4ol0k6',
      tier: 'cohort',
    });
    expect(c.ask_max_tier).toBe('cohort');
  });
  it('honors explicit ask_max_tier', () => {
    const c = buildScopeClaim({
      requesterName: 'leroy',
      agentId: 'pai-leroy-mn4ol0k6',
      tier: 'sacred',
      askMaxTier: 'public',
    });
    expect(c.ask_max_tier).toBe('public');
  });
  it('produces a parseable ts', () => {
    const c = buildScopeClaim({
      requesterName: 'leroy',
      agentId: 'pai-leroy-mn4ol0k6',
      tier: 'public',
    });
    expect(isNaN(Date.parse(c.ts))).toBe(false);
  });
});
