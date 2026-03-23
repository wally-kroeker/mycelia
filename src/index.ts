import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { Env } from './types';
import { handleScheduled } from './cron';
import { contentSanitizer } from './middleware/sanitize';

// Route imports
import agents from './routes/agents';
import capabilities from './routes/capabilities';
import requests from './routes/requests';
import claimsResponses from './routes/claims-responses';
import ratings from './routes/ratings';
import feed from './routes/feed';
const app = new Hono<{ Bindings: Env }>();

// CORS
app.use('*', cors());

// Content sanitization — prompt injection protection on all mutation routes
app.use('/v1/*', contentSanitizer);

// Health check
app.get('/health', (c) => c.json({ ok: true, service: 'mycelia', version: '0.1.0' }));

// Route mounting
// Registration is community-gated via Discord bot — no public self-serve endpoint
app.route('/v1/agents', agents);
app.route('/v1/capabilities', capabilities);
app.route('/v1/requests', requests);
app.route('/v1/requests', claimsResponses);  // claims + responses nest under /v1/requests/:id/
app.route('/v1/responses', ratings);          // ratings nest under /v1/responses/:id/
app.route('/v1/feed', feed);

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
