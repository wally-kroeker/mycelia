import { describe, it, expect } from 'vitest';
import { generateApiKey, hashApiKey } from '../src/middleware/auth';

describe('key rotation — key generation', () => {
  it('generates a valid agent key with correct prefix format', async () => {
    const { key, hash, prefix } = await generateApiKey();

    expect(key).toMatch(/^mycelia_live_[a-f0-9]{64}$/);
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
    expect(prefix).toBe(key.substring(0, 21));
    expect(prefix).toMatch(/^mycelia_live_[a-f0-9]{8}$/);
  });

  it('generates unique keys on each call', async () => {
    const key1 = await generateApiKey();
    const key2 = await generateApiKey();

    expect(key1.key).not.toBe(key2.key);
    expect(key1.hash).not.toBe(key2.hash);
    expect(key1.prefix).not.toBe(key2.prefix);
  });

  it('hash matches when re-hashed (round-trip verification)', async () => {
    const { key, hash } = await generateApiKey();
    const reHash = await hashApiKey(key);

    expect(reHash).toBe(hash);
  });

  it('different keys produce different hashes', async () => {
    const { hash: hash1 } = await generateApiKey();
    const { hash: hash2 } = await generateApiKey();

    expect(hash1).not.toBe(hash2);
  });

  it('old key hash does not match new key', async () => {
    const oldKey = await generateApiKey();
    const newKey = await generateApiKey();

    // Simulates rotation: old hash should NOT match new key
    const oldKeyReHash = await hashApiKey(oldKey.key);
    const newKeyReHash = await hashApiKey(newKey.key);

    expect(oldKeyReHash).toBe(oldKey.hash);
    expect(newKeyReHash).toBe(newKey.hash);
    expect(oldKeyReHash).not.toBe(newKeyReHash);
  });

  it('prefix is exactly 21 characters (13-char prefix + 8 hex chars)', async () => {
    const { prefix } = await generateApiKey();

    expect(prefix.length).toBe(21);
    expect(prefix.startsWith('mycelia_live_')).toBe(true);
  });
});

// Observer key type removed in Phase 3 (fleet-coordination-v1).
// generateApiKey('observer') no longer exists; any key with mycelia_obs_ prefix
// returns 401 from authMiddleware (no agents row). These tests are replaced by
// a check that generateApiKey always produces a live-prefixed key.
describe('key generation — agent key only (Phase 3: observer type removed)', () => {
  it('generates agent key with mycelia_live_ prefix', async () => {
    const { key, prefix } = await generateApiKey();
    expect(key).toMatch(/^mycelia_live_[a-f0-9]{64}$/);
    // prefix: 'mycelia_live_' (13 chars) + 8 hex = 21 chars
    expect(prefix.length).toBe(21);
    expect(prefix.startsWith('mycelia_live_')).toBe(true);
  });

  it('two generateApiKey() calls produce different keys', async () => {
    const a = await generateApiKey();
    const b = await generateApiKey();
    expect(a.key).not.toBe(b.key);
    expect(a.prefix).not.toBe(b.prefix);
  });
});

describe('key rotation — hash consistency', () => {
  it('SHA-256 hash is deterministic for same input', async () => {
    const testKey = 'mycelia_live_0000000000000000000000000000000000000000000000000000000000000000';
    const hash1 = await hashApiKey(testKey);
    const hash2 = await hashApiKey(testKey);

    expect(hash1).toBe(hash2);
  });

  it('hash changes with any character change in key', async () => {
    const key1 = 'mycelia_live_0000000000000000000000000000000000000000000000000000000000000000';
    const key2 = 'mycelia_live_0000000000000000000000000000000000000000000000000000000000000001';

    const hash1 = await hashApiKey(key1);
    const hash2 = await hashApiKey(key2);

    expect(hash1).not.toBe(hash2);
  });
});
