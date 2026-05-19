// src/lib/revocation.ts
// Kill-switch primitive (B8 from combined redteam 2026-05-18).
// Adds an agent_id to a KV revocation set. Every claim/respond/post checks it.
// Revoked agent fails every action regardless of API key validity.

// Uses ambient KVNamespace from @cloudflare/workers-types (loaded globally).
const KV_PREFIX = 'revoke:';

export interface RevocationEntry {
  agent_id: string;
  reason: string;
  revoked_by: string;
  revoked_at: string;
  revoke_until: string | null; // ISO timestamp; null = forever
}

/**
 * Check whether an agent is currently revoked.
 * Returns the entry if revoked + still in effect, null otherwise.
 * Auto-expires entries whose revoke_until has passed.
 */
export async function checkRevoked(kv: KVNamespace, agentId: string): Promise<RevocationEntry | null> {
  const raw = await kv.get(KV_PREFIX + agentId, 'json');
  if (!raw) return null;
  const entry = raw as RevocationEntry;
  if (entry.revoke_until) {
    const until = Date.parse(entry.revoke_until);
    if (!isNaN(until) && until < Date.now()) {
      // Expired — clear it
      await kv.delete(KV_PREFIX + agentId);
      return null;
    }
  }
  return entry;
}

/**
 * Revoke an agent.
 *  - `revokedBy` MUST be either Rob (admin) or the agent itself (self-revoke).
 *    Caller is responsible for that authorization check.
 *  - `revokeUntilIso` is optional ISO-8601; null/undefined = revoke forever.
 */
export async function revoke(
  kv: KVNamespace,
  agentId: string,
  reason: string,
  revokedBy: string,
  revokeUntilIso?: string | null,
): Promise<RevocationEntry> {
  const entry: RevocationEntry = {
    agent_id: agentId,
    reason,
    revoked_by: revokedBy,
    revoked_at: new Date().toISOString(),
    revoke_until: revokeUntilIso ?? null,
  };
  await kv.put(KV_PREFIX + agentId, JSON.stringify(entry));
  return entry;
}

/**
 * Lift a revocation. Caller authorizes (Rob only typically).
 */
export async function unrevoke(kv: KVNamespace, agentId: string): Promise<boolean> {
  await kv.delete(KV_PREFIX + agentId);
  return true;
}
