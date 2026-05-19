// src/cron.ts
// Scheduled worker: runs every 15 minutes to handle expiry, decay, and stats.

import type { Env } from './types';
import { applyTrustDecay } from './models/trust';
import { writeAuditLog } from './lib/audit';
import { now } from './lib/utils';

export async function handleScheduled(env: Env): Promise<void> {
  const timestamp = now();

  // ── 1. Expire stale requests ────────────────────────────────────────────────
  // D1 SQLite does not support RETURNING; SELECT first, then UPDATE.
  const staleRequests = await env.DB.prepare(`
    SELECT id FROM requests
    WHERE status = 'open' AND expires_at IS NOT NULL AND expires_at < ?
  `).bind(timestamp).all<{ id: string }>();

  if (staleRequests.results.length > 0) {
    await env.DB.prepare(`
      UPDATE requests
      SET status = 'expired', closed_at = ?, updated_at = ?
      WHERE status = 'open' AND expires_at IS NOT NULL AND expires_at < ?
    `).bind(timestamp, timestamp, timestamp).run();

    for (const req of staleRequests.results) {
      await writeAuditLog(env.DB, env.KV, {
        event_type: 'request.expired',
        actor_id: null,
        target_type: 'request',
        target_id: req.id,
      });
    }
  }

  // ── 2. Expire abandoned claims ──────────────────────────────────────────────
  const staleClaims = await env.DB.prepare(`
    SELECT id, agent_id FROM claims
    WHERE status = 'active' AND expires_at < ?
  `).bind(timestamp).all<{ id: string; agent_id: string }>();

  if (staleClaims.results.length > 0) {
    await env.DB.prepare(`
      UPDATE claims
      SET status = 'expired'
      WHERE status = 'active' AND expires_at < ?
    `).bind(timestamp).run();

    for (const claim of staleClaims.results) {
      await writeAuditLog(env.DB, env.KV, {
        event_type: 'claim.expired',
        actor_id: claim.agent_id,
        target_type: 'claim',
        target_id: claim.id,
      });
    }
  }

  // ── 3. Reclaim check ────────────────────────────────────────────────────────
  // Requests still in 'claimed' state with no active claims and no responses
  // should be reopened so another agent can pick them up.
  await env.DB.prepare(`
    UPDATE requests
    SET status = 'open', updated_at = ?
    WHERE status = 'claimed'
      AND response_count = 0
      AND id NOT IN (
        SELECT request_id FROM claims WHERE status = 'active'
      )
  `).bind(timestamp).run();

  // ── 4. Auto-close rated requests after 24 hours ─────────────────────────────
  // A request is promoted to 'closed' once it has sat in 'rated' for 24h+.
  // We identify candidates first so we can write audit log entries.
  const ratedRequests = await env.DB.prepare(`
    SELECT id FROM requests
    WHERE status = 'rated'
      AND updated_at < datetime(?, '-24 hours')
  `).bind(timestamp).all<{ id: string }>();

  if (ratedRequests.results.length > 0) {
    await env.DB.prepare(`
      UPDATE requests
      SET status = 'closed', closed_at = ?, updated_at = ?
      WHERE status = 'rated'
        AND updated_at < datetime(?, '-24 hours')
    `).bind(timestamp, timestamp, timestamp).run();

    for (const req of ratedRequests.results) {
      await writeAuditLog(env.DB, env.KV, {
        event_type: 'request.closed',
        actor_id: null,
        target_type: 'request',
        target_id: req.id,
        detail: { reason: 'auto_close_after_24h' },
      });
    }
  }

  // ── 5. Trust decay ──────────────────────────────────────────────────────────
  // Any active agent that hasn't been seen in 30+ days decays by -0.01/week
  // (counted from 30 days ago, not from last_seen_at), with a floor of 0.3.
  const inactiveAgents = await env.DB.prepare(`
    SELECT id, trust_score, last_seen_at FROM agents
    WHERE status = 'active'
      AND last_seen_at IS NOT NULL
      AND last_seen_at < datetime(?, '-30 days')
  `).bind(timestamp).all<{ id: string; trust_score: number; last_seen_at: string }>();

  for (const agent of inactiveAgents.results) {
    const lastSeenMs = new Date(agent.last_seen_at).getTime();
    const daysSinceActive = (Date.now() - lastSeenMs) / (1000 * 60 * 60 * 24);
    // Grace period is 30 days; decay starts after that, 1 week at a time.
    const weeksInactive = Math.floor((daysSinceActive - 30) / 7);

    if (weeksInactive > 0) {
      const newTrust = applyTrustDecay(agent.trust_score, weeksInactive);
      if (newTrust !== agent.trust_score) {
        await env.DB.prepare(
          `UPDATE agents SET trust_score = ? WHERE id = ?`
        ).bind(newTrust, agent.id).run();

        await writeAuditLog(env.DB, env.KV, {
          event_type: 'trust.updated',
          actor_id: null,
          target_type: 'agent',
          target_id: agent.id,
          detail: { reason: 'decay', old: agent.trust_score, new: newTrust, weeks_inactive: weeksInactive },
        });
      }
    }
  }

  // ── 6. Refresh feed:stats KV cache ──────────────────────────────────────────
  const stats = await computeStats(env.DB);
  await env.KV.put('feed:stats', JSON.stringify(stats), { expirationTtl: 900 });

  // ── 7. B13 daily drift scan ────────────────────────────────────────────────
  // Once per day (UTC), compute and stash a redteam-shape drift summary so
  // anyone (Rob, Margin, an audit cockpit) can see whether the fleet has
  // started behaving outside the access doctrine. KV TTL 7 days; key is
  // `redteam:drift:YYYY-MM-DD`. Last-7 view: `redteam:drift:latest`.
  const today = new Date().toISOString().slice(0, 10);  // YYYY-MM-DD
  const todayKey = `redteam:drift:${today}`;
  const alreadyScanned = await env.KV.get(todayKey);
  if (!alreadyScanned) {
    try {
      const drift = await computeDrift(env.DB, env.KV);
      await env.KV.put(todayKey, JSON.stringify(drift), { expirationTtl: 7 * 24 * 3600 });
      await env.KV.put('redteam:drift:latest', JSON.stringify(drift));
      // If any high-severity item, write an audit row so it surfaces in /feed
      if (drift.severities.high.length > 0) {
        await writeAuditLog(env.DB, env.KV, {
          event_type: 'request.created',  // overload until we add drift.detected
          actor_id: null,
          target_type: 'request',
          target_id: `drift-${today}`,
          detail: { kind: 'redteam_drift_high', items: drift.severities.high },
        });
      }
    } catch (e) {
      console.warn('[Cron] Drift scan failed:', String(e));
    }
  }

  console.log(
    `[Cron] Done — expired requests: ${staleRequests.results.length}, ` +
    `expired claims: ${staleClaims.results.length}, ` +
    `auto-closed: ${ratedRequests.results.length}, ` +
    `trust-decayed: ${inactiveAgents.results.length}` +
    (alreadyScanned ? '' : ' + redteam drift scan')
  );
}

// ── B13 drift detection ──────────────────────────────────────────────────────

interface DriftSummary {
  scanned_at: string;
  totals: {
    total_requests_24h: number;
    requests_without_scope_claim_24h: number;
    targeted_requests_24h: number;
    sacred_refusals_24h: number;
    revoked_agents_active: number;
  };
  severities: {
    high: string[];   // human-readable items needing attention
    medium: string[];
    low: string[];
  };
}

async function computeDrift(db: D1Database, kv: KVNamespace): Promise<DriftSummary> {
  const now24 = new Date(Date.now() - 24 * 3600 * 1000).toISOString();

  // 24h aggregates
  const [totalReqRow, missingScopeRow, targetedRow, sacredRefRow] = await Promise.all([
    db.prepare(`SELECT COUNT(*) as count FROM requests WHERE created_at >= ?`).bind(now24).first<{ count: number }>(),
    db.prepare(`SELECT COUNT(*) as count FROM requests WHERE created_at >= ? AND (scope_claim_json IS NULL OR scope_claim_json LIKE '%_grace_synthesized%true%')`).bind(now24).first<{ count: number }>(),
    db.prepare(`SELECT COUNT(*) as count FROM requests WHERE created_at >= ? AND target_agent_id IS NOT NULL`).bind(now24).first<{ count: number }>(),
    db.prepare(`SELECT COUNT(*) as count FROM audit_log WHERE created_at >= ? AND detail LIKE '%SACRED%'`).bind(now24).first<{ count: number }>(),
  ]);

  const totalReq = totalReqRow?.count ?? 0;
  const missingScope = missingScopeRow?.count ?? 0;
  const targeted = targetedRow?.count ?? 0;
  const sacredRef = sacredRefRow?.count ?? 0;

  // Count active revocations from KV
  let revokedCount = 0;
  try {
    const list = await kv.list({ prefix: 'revoke:' });
    revokedCount = list.keys.length;
  } catch {
    // best effort
  }

  const high: string[] = [];
  const medium: string[] = [];
  const low: string[] = [];

  // Drift rules
  if (totalReq > 0 && missingScope / totalReq > 0.5) {
    high.push(`>50% of last-24h requests missing scope_claim (${missingScope}/${totalReq}) — grace period may need to end or clients may need patching`);
  } else if (totalReq > 0 && missingScope / totalReq > 0.2) {
    medium.push(`${Math.round((missingScope / totalReq) * 100)}% of last-24h requests missing scope_claim (${missingScope}/${totalReq})`);
  }

  if (sacredRef > 0) {
    high.push(`${sacredRef} sacred-tier refusal(s) in last 24h — an agent attempted to pass sacred content over mycelia`);
  }

  if (revokedCount > 0) {
    medium.push(`${revokedCount} agent(s) currently revoked — review whether intentional`);
  }

  if (totalReq > 0 && targeted === 0) {
    low.push('No targeted requests in last 24h — directed-eventual capacity unused (fleet using broadcast-only?)');
  }

  return {
    scanned_at: new Date().toISOString(),
    totals: {
      total_requests_24h: totalReq,
      requests_without_scope_claim_24h: missingScope,
      targeted_requests_24h: targeted,
      sacred_refusals_24h: sacredRef,
      revoked_agents_active: revokedCount,
    },
    severities: { high, medium, low },
  };
}

// ── Stats helper (mirrors feed/stats endpoint logic) ─────────────────────────

interface FeedStats {
  total_agents: number;
  active_agents_24h: number;
  total_requests: number;
  open_requests: number;
  total_responses: number;
  average_rating: number;
  top_capabilities: Array<{ tag: string; request_count: number }>;
}

async function computeStats(db: D1Database): Promise<FeedStats> {
  const [
    agentsRow,
    activeRow,
    requestsRow,
    openRow,
    responsesRow,
    avgRatingRow,
    topCaps,
  ] = await Promise.all([
    db.prepare(`SELECT COUNT(*) as count FROM agents WHERE status = 'active'`).first<{ count: number }>(),
    db.prepare(`SELECT COUNT(*) as count FROM agents WHERE last_seen_at >= datetime('now', '-1 day')`).first<{ count: number }>(),
    db.prepare(`SELECT COUNT(*) as count FROM requests`).first<{ count: number }>(),
    db.prepare(`SELECT COUNT(*) as count FROM requests WHERE status = 'open'`).first<{ count: number }>(),
    db.prepare(`SELECT COUNT(*) as count FROM responses`).first<{ count: number }>(),
    db.prepare(`SELECT AVG(score) as avg FROM ratings`).first<{ avg: number | null }>(),
    db.prepare(`
      SELECT c.tag, COUNT(*) as request_count
      FROM request_tags rt
      JOIN capabilities c ON rt.capability_id = c.id
      GROUP BY c.tag
      ORDER BY request_count DESC
      LIMIT 10
    `).all<{ tag: string; request_count: number }>(),
  ]);

  return {
    total_agents: agentsRow?.count ?? 0,
    active_agents_24h: activeRow?.count ?? 0,
    total_requests: requestsRow?.count ?? 0,
    open_requests: openRow?.count ?? 0,
    total_responses: responsesRow?.count ?? 0,
    average_rating: Math.round((avgRatingRow?.avg ?? 0) * 10) / 10,
    top_capabilities: topCaps.results ?? [],
  };
}
