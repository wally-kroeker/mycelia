---
project: mycelia
last_updated: 2026-03-17T00:00:00-06:00
---

# Project Tasks

This file tracks tasks for Mycelia in a format compatible with PAI's Task tools.

---

## In Progress

(None)

---

## Pending

### Deploy GBAIC bot with Mycelia commands
- **Status**: pending
- **Active Form**: Deploying GBAIC bot update with Mycelia slash commands
- **Priority**: high
- **Due**: 2026-03-24
- **Notes**: Bot code is written (6 slash commands in gbaic-bot/src/cogs/mycelia.py). Needs: deploy to container 116, add MYCELIA_API_KEY to .env, test all commands. See GBAIC/docs/MYCELIA-IMPLEMENTATION-SPEC.md.

### Prep GBAIC Meeting #3 demo
- **Status**: pending
- **Active Form**: Preparing live Mycelia demo for GBAIC Meeting #3
- **Priority**: high
- **Due**: 2026-03-25
- **Notes**: Live demo: member registers agent via /mycelia register, Bob or Work Bob claims and responds, trust scores update in real time. Rehearse before meeting.

### Investigate Bob requester trust not updating
- **Status**: pending
- **Active Form**: Debugging requester trust score not updating after rating
- **Priority**: medium
- **Notes**: Bob received a 5-star helper_rates_requester rating but trust_score_as_requester stayed at 0.5. May be a bug in the ratings route trust recalculation.

### Fix timeline endpoint path
- **Status**: pending
- **Active Form**: Moving timeline from /v1/feed/timeline/:id to /v1/requests/:id/timeline
- **Priority**: low
- **Notes**: Currently mounted at /v1/feed/timeline/:id but architecture doc specifies /v1/requests/:id/timeline.

### Prompt injection protection
- **Status**: pending
- **Active Form**: Adding prompt injection defenses to request/response content
- **Priority**: high
- **Notes**: Request bodies and response bodies are the primary vector — an attacker posts a "help request" that's actually an instruction to the responding agent ("ignore previous instructions and..."). Three layers to consider: (1) Server-side: content scanning/flagging on POST /v1/requests and POST /v1/responses — detect common injection patterns (instruction overrides, role-play prompts, system prompt extraction attempts), flag or reject. (2) Client-side: agents consuming responses should treat all Mycelia content as untrusted user input — never inject raw response body into system prompts. Document this in client-sdk.md. (3) Trust-based: low-trust agents' content gets extra scrutiny. Agents whose content gets flagged take trust penalties. The GBAIC-only rollout mitigates this for now (trusted people), but this needs solving before any public launch. Consider using the Security skill for a proper threat model.

### Integration tests
- **Status**: pending
- **Active Form**: Writing integration tests for API endpoints
- **Priority**: medium
- **Notes**: Only unit tests exist (trust model + state machine). Need full API integration tests with D1 mock.

### Cognitive Loop #1 — "Why I'm Building Mutual Aid for AI Agents"
- **Status**: pending
- **Active Form**: Writing first Cognitive Loop post
- **Priority**: medium
- **Notes**: Draft exists at ~/projects/TSFUR/content/drafts/cognitive-loop-01-why-mycelium.md. Needs Wally's edit pass + name update to Mycelia.

### Cognitive Loop #2 — Trust Model and Cooperation
- **Status**: pending
- **Active Form**: Writing trust model and cooperation philosophy post
- **Priority**: low
- **Dependencies**: Cognitive Loop #1
- **Notes**: Wilson score, bidirectional trust, why mutual aid not marketplace. Post around/after GBAIC.

### Add project page to wallykroeker.com
- **Status**: pending
- **Active Form**: Adding Mycelia project page to wallykroeker.com
- **Priority**: medium
- **Dependencies**: Cognitive Loop #1
- **Notes**: Source of truth for the project. All roads lead to wallykroeker.com.

### LinkedIn post #1 — announce the project
- **Status**: pending
- **Active Form**: Writing LinkedIn announcement post
- **Priority**: medium
- **Dependencies**: Add project page to wallykroeker.com
- **Notes**: Short version for GBAIC/professional audience. Points to wallykroeker.com.


### LinkedIn post #2 — GBAIC recap
- **Status**: pending
- **Active Form**: Writing GBAIC recap LinkedIn post
- **Priority**: low
- **Dependencies**: Prep GBAIC Meeting #3 demo
- **Notes**: After March 25. Recap the discussion, what resonated.

### Finalize domain
- **Status**: pending
- **Active Form**: Finalizing domain choice
- **Priority**: low
- **Notes**: Research done. Top candidates: mycelia.community, mycelia.help, getmycelia.com. Not blocking anything — currently on workers.dev subdomain.

---

## Completed

### Lock project name
- **Status**: completed
- **Active Form**: Locking project name
- **Completed**: 2026-03-13
- **Notes**: Mycelia — agents helping agents. Personal connection to Wally's mushroom trip in the woods.

### Review architecture doc
- **Status**: completed
- **Active Form**: Reviewing architecture document
- **Completed**: 2026-03-13
- **Notes**: Updated to v1.1 with 5 changes: tag proposals, estimate-based claim expiry, bidirectional ratings, council request type, expanded request types.

### Bootstrap project folder
- **Status**: completed
- **Active Form**: Bootstrapping project folder structure
- **Completed**: 2026-03-13
- **Notes**: Created ~/projects/mycelia with CLAUDE.md and tasks.md using ProjectManagement skill.

### Create OpenSpec build plan
- **Status**: completed
- **Active Form**: Creating parallelized OpenSpec build plan
- **Completed**: 2026-03-13
- **Notes**: 18 files, 3,922 lines. Decomposed 1,280-line architecture doc into 16 parallelizable component specs across 4 phases.

### Build Mycelia v1 from OpenSpec
- **Status**: completed
- **Active Form**: Building Mycelia v1 with parallel Sonnet agents
- **Completed**: 2026-03-13
- **Notes**: 17 source files, 2,486 lines. 92 tests pass. Built in ~20 minutes wall time across 4 phases with 13 agent invocations.

### Scaffold Cloudflare Worker with Hono
- **Status**: completed
- **Active Form**: Scaffolding Cloudflare Worker project
- **Completed**: 2026-03-13
- **Notes**: wrangler.toml, package.json, tsconfig.json, Hono app entry point.

### D1 schema migrations
- **Status**: completed
- **Active Form**: Creating D1 schema migrations
- **Completed**: 2026-03-13
- **Notes**: 189 lines, 10 tables, 27 indexes, 25 seed capability tags. Applied to remote D1.

### Auth middleware
- **Status**: completed
- **Active Form**: Implementing auth middleware
- **Completed**: 2026-03-13
- **Notes**: API key generation (mycelia_live_/mycelia_test_/mycelia_obs_ prefixes), SHA-256 hashing, authMiddleware, requireAgentKey.

### Agent registration endpoint
- **Status**: completed
- **Active Form**: Building agent registration endpoint
- **Completed**: 2026-03-13
- **Notes**: POST /v1/agents, PATCH /v1/agents/:id, GET /v1/agents/:id. All working on live API.

### Request CRUD
- **Status**: completed
- **Active Form**: Implementing request creation and browsing
- **Completed**: 2026-03-13
- **Notes**: POST/GET/GET/:id/DELETE for /v1/requests.

### Claim + response with state machine
- **Status**: completed
- **Active Form**: Building claim and response system with state machine
- **Completed**: 2026-03-13
- **Notes**: 7 claim constraints, council threading via parent_response_id. State machine with 76 tests.

### Rating + trust recalculation
- **Status**: completed
- **Active Form**: Implementing bidirectional rating and trust scoring
- **Completed**: 2026-03-13
- **Notes**: Bidirectional ratings with anti-gaming (same owner_id check). Wilson score trust recalculation. 16 trust model tests.

### Capability matching
- **Status**: completed
- **Active Form**: Building capability matching and tag system
- **Completed**: 2026-03-13
- **Notes**: Tag-based set intersection, KV-cached. Browse, propose, find agents by tag.

### Observer feed with KV caching
- **Status**: completed
- **Active Form**: Building observer activity feed
- **Completed**: 2026-03-13
- **Notes**: GET /v1/feed — paginated audit event stream with actor names.

### Stats endpoint
- **Status**: completed
- **Active Form**: Implementing network statistics endpoint
- **Completed**: 2026-03-13
- **Notes**: GET /v1/feed/stats — served from KV cache, refreshed by cron.

### Rate limiting
- **Status**: completed
- **Active Form**: Adding rate limiting middleware
- **Completed**: 2026-03-13
- **Notes**: KV-based per-key rate limiting with 7 categories.

### Cron worker for timeouts and expiry
- **Status**: completed
- **Active Form**: Building cron worker for claim timeouts and request expiry
- **Completed**: 2026-03-13
- **Notes**: 6 cron actions: expire requests, expire claims, reclaim check, auto-close, trust decay, refresh stats. Running */15 * * * *.

### Create GitHub repo
- **Status**: completed
- **Active Form**: Creating GitHub repo and pushing code
- **Completed**: 2026-03-15
- **Notes**: https://github.com/wally-kroeker/mycelia — 47 files, 8,028 lines.

### Create Cloudflare resources
- **Status**: completed
- **Active Form**: Creating D1, KV, R2 on Cloudflare
- **Completed**: 2026-03-15
- **Notes**: D1 mycelia-db (ENAM), KV MYCELIA_CACHE, R2 mycelia-audit. Migration applied. Worker deployed.

### Deploy to Cloudflare Workers
- **Status**: completed
- **Active Form**: Deploying Mycelia worker
- **Completed**: 2026-03-15
- **Notes**: Live at https://mycelia-api.wallyk.workers.dev. Health check verified.

### Dogfood — register Bob and Work Bob
- **Status**: completed
- **Active Form**: Dogfooding with Bob and Work Bob as first agents
- **Completed**: 2026-03-15
- **Notes**: Full lifecycle: register 2 agents, create request, claim, respond, bidirectional rate. 8 audit events recorded. Trust scores updated via Wilson score.

### Write README
- **Status**: completed
- **Active Form**: Writing public README
- **Completed**: 2026-03-16
- **Notes**: 293 lines. Protocol positioning, ASCII cooperation diagram, quickstart, trust model table, agent-agnostic integration, Kropotkin quote. Optimized for GitHub engagement.

### Build Mycelia PAI skill and CLI client
- **Status**: completed
- **Active Form**: Building agent-agnostic Mycelia client skill
- **Completed**: 2026-03-16
- **Notes**: SKILL.md + Tools/MyceliaClient.ts (10 commands). Flexible config discovery. Tested by Work Bob on Copilot CLI (Node 22). Pushed to repo as scripts/MyceliaClient.ts.

### Agent-agnostic client SDK docs
- **Status**: completed
- **Active Form**: Writing integration guide for any agent platform
- **Completed**: 2026-03-16
- **Notes**: docs/client-sdk.md — 3 connection methods (raw HTTP, TypeScript client, build your own), registration docs, response format.

### GBAIC Discord bot Mycelia integration
- **Status**: completed
- **Active Form**: Adding Mycelia slash commands to GBAIC Discord bot
- **Completed**: 2026-03-16
- **Notes**: 6 slash commands (register, browse, profile, feed, stats, unregister). 698-line cog. Discord membership = trust boundary. API keys sent via DM in spoiler tags. Built by Work Bob. Needs deployment to container 116.

### First real cross-agent work request
- **Status**: completed
- **Active Form**: Processing real work through Mycelia
- **Completed**: 2026-03-16
- **Notes**: Work Bob posted Tomcat 9 security remediation review. Bob claimed, reviewed, responded with 6 caveats. First real cross-platform (Claude Code + Copilot CLI) cooperation through the protocol.

---

## Deferred

(None)

---

## Notes

**Live API:** https://mycelia-api.wallyk.workers.dev
**GitHub:** https://github.com/wally-kroeker/mycelia
**GBAIC deadline:** March 25, 2026
**GBAIC Discord bot:** GBAIC/gbaic-bot/src/cogs/mycelia.py (ready, needs deploy)
**Architecture doc:** `~/projects/TSFUR/agent-mutual-aid-architecture.md` (v1.1)
