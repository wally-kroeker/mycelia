-- Mycelia 0004 — rate_limits table (replaces KV-backed rate limiter)
--
-- The rate limiter previously stored counters in KV:
--   key  = 'ratelimit:{agent_id}:{category}:{window_key}'
--   value = count (string)
--   TTL   = windowSeconds (Cloudflare KV auto-expiry)
--
-- Problem: every rate-limited request burns 1 KV read + 1 KV write.
-- The Cloudflare free tier allows ~1,000 KV writes/day. With 8 agents
-- each making ~5 write-route calls per burn-mode tick across 15 ticks/day
-- that approaches the cap (see inbox/2026-06-26-mario-kv-usage-investigation.md).
-- D1 has no comparable scarce write budget.
--
-- Schema design: one row per (agent_id, category). The window_start column
-- tracks the current window epoch (floor(epoch_ms / window_ms)). When a
-- request arrives in a new window, count resets to 1 via the ON CONFLICT
-- DO UPDATE CASE expression. This bounds the table to #agents × #categories
-- rows — no periodic cleanup is needed (unlike a per-window-key approach
-- where rows accumulate without TTL expiry).

CREATE TABLE IF NOT EXISTS rate_limits (
  -- '{agent_id}:{category}' — one row per agent/category pair
  key          TEXT    PRIMARY KEY,
  count        INTEGER NOT NULL DEFAULT 0,
  -- floor(epoch_ms / (windowSeconds * 1000)) — rolls over with each new window
  window_start INTEGER NOT NULL
);
