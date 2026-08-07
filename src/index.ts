import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { Env } from './types';
import { handleScheduled } from './cron';
import { contentSanitizer } from './middleware/sanitize';
import { validateMode } from './middleware/fleet-gate';

// Route imports
import agents from './routes/agents';
import register from './routes/register';
import capabilities from './routes/capabilities';
import requests from './routes/requests';
import claimsResponses from './routes/claims-responses';
import ratings from './routes/ratings';
import feed from './routes/feed';
import admin from './routes/admin';
import schemas from './routes/schemas';

const app = new Hono<{ Bindings: Env }>();

// CORS
app.use('*', cors());

// Content sanitization — prompt injection protection on all mutation routes
app.use('/v1/*', contentSanitizer);

// MODE validation — fail-closed on every request if MODE is unset or invalid.
// Runs before route logic; prevents serving in an unknown trust state.
// Set MODE in wrangler.toml [vars] or [env.X.vars]. See .dev.vars.example.
app.use('*', async (c, next) => {
  validateMode(c.env); // throws on invalid MODE — caught by the error handler → 500
  await next();
});

// Health check — runs after mode validation so an unconfigured node is visible.
app.get('/health', (c) => {
  const mode = c.env.MODE ?? 'UNSET';
  return c.json({ ok: true, service: 'mycelia', version: '0.2.0', mode });
});

// Route mounting
// /v1/agents/register — public self-serve registration (gated by registrationGate in fleet/company).
// Must be mounted BEFORE /v1/agents so the more-specific path wins.
app.route('/v1/agents/register', register);
app.route('/v1/agents', agents);
app.route('/v1/capabilities', capabilities);
app.route('/v1/requests', requests);
app.route('/v1/requests', claimsResponses);  // claims + responses nest under /v1/requests/:id/
app.route('/v1/responses', ratings);          // ratings nest under /v1/responses/:id/
app.route('/v1/feed', feed);
app.route('/v1/admin', admin);
app.route('/v1/schemas', schemas);        // Self-describing endpoint body shapes

// 404 handler
app.notFound((c) => c.json({
  ok: false,
  error: { code: 'NOT_FOUND', message: 'Endpoint not found' },
  meta: { request_id: crypto.randomUUID(), timestamp: new Date().toISOString() }
}, 404));

// Error handler
app.onError((err, c) => {
  console.error('Unhandled error:', err);
  return c.json({
    ok: false,
    error: { code: 'INTERNAL_ERROR', message: 'Internal server error' },
    meta: { request_id: crypto.randomUUID(), timestamp: new Date().toISOString() }
  }, 500);
});

// Cron handler
export default {
  fetch: app.fetch,
  scheduled: async (event: ScheduledEvent, env: Env, ctx: ExecutionContext) => {
    ctx.waitUntil(handleScheduled(env));
  }
};
