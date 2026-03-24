---
project: mycelia
last_updated: 2026-03-24T13:00:00-06:00
---

# Project Tasks

This file tracks tasks for Mycelia in a format compatible with PAI's Task tools.

---

## In Progress

### Prep GBAIC Meeting #3 demo
- **Status**: in_progress
- **Active Form**: Preparing live Mycelia demo for GBAIC Meeting #3
- **Priority**: high
- **Due**: 2026-03-25
- **Notes**: Three-platform test complete. Blog posted. GBAIC members registering agents. First issue filed and addressed (PR #2). Need to rehearse live demo flow and deploy bot spoiler fix to FabLab.

### Review and merge PR #2 (sanitizer improvements)
- **Status**: in_progress
- **Active Form**: Reviewing sanitizer improvements from issue #1
- **Priority**: high
- **Notes**: All 6 gaps from Ivy/jcfischer implemented. 174 tests passing. Includes encoding bypass, tool invocation, PII scanning, cross-field aggregation. Branch: feat/sanitizer-improvements-issue-1. Deploy after merge.

---

## Pending

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
- **Notes**: Wilson score, bidirectional trust, why mutual aid not marketplace.

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

### Fix timeline endpoint path
- **Status**: pending
- **Active Form**: Moving timeline from /v1/feed/timeline/:id to /v1/requests/:id/timeline
- **Priority**: low
- **Notes**: Currently mounted at /v1/feed/timeline/:id but architecture doc specifies /v1/requests/:id/timeline.

### Integration tests
- **Status**: pending
- **Active Form**: Writing integration tests for API endpoints
- **Priority**: medium
- **Notes**: Unit tests (trust model + state machine + sanitizer) at 153 passing. Need full API integration tests with D1 mock.

### Finalize domain
- **Status**: pending
- **Active Form**: Finalizing domain choice
- **Priority**: low
- **Notes**: Research done. Top candidates: mycelia.community, mycelia.help, getmycelia.com. Not blocking anything — currently on workers.dev subdomain.

### Implement exponential trust decay
- **Status**: pending
- **Active Form**: Replacing linear trust decay with exponential model
- **Priority**: medium
- **Notes**: Bill (Codex) and Gemini both recommended exponential decay with 21-day grace period, 45-60 day half-life, floor of 0.1-0.15, per-capability. Current: linear -0.01/week, 30-day grace, 0.3 floor. Worth implementing based on integration test feedback.

### Deploy bot spoiler tag fix to FabLab
- **Status**: pending
- **Active Form**: Deploying Discord bot fix to FabLab container 116
- **Priority**: high
- **Notes**: Removed spoiler tags from API key DM (embed fields don't render spoilers on all clients). Committed locally in GBAIC repo. Needs scp to FabLab + docker restart gbaic-bot. Handoff created.

### Community-as-package vision
- **Status**: pending
- **Active Form**: Designing Mycelia as deployable per-community package
- **Priority**: low
- **Notes**: Each Discord server / community gets its own Mycelia instance. Community membership = trust boundary. GBAIC is the proof-of-concept. Future architecture work.

### Node federation — inter-community cooperation
- **Status**: pending
- **Active Form**: Designing protocol for Mycelia nodes to communicate across communities
- **Priority**: medium
- **Notes**: Each community (GBAIC, etc.) runs its own Mycelia node with its own trust boundary. Federation lets nodes discover each other and route requests across communities. An agent trusted in GBAIC could claim requests from another community's node, with trust translating across boundaries. This is how the web grows — not one central server, but interconnected community nodes. Design questions: trust portability (does GBAIC trust transfer?), request routing (broadcast vs directed), node discovery (registry vs gossip), identity (agent IDs across nodes). Think ActivityPub/fediverse model but for agent cooperation. This is the long-term vision — Mycelia becomes the mycelial network between communities, not just within one.

---

## Completed

### Add reference Discord bot to repo
- **Status**: completed
- **Completed**: 2026-03-24
- **Notes**: Extracted mycelia_client.py + cogs/mycelia.py into network-management-examples/discord-bot/. Guild ID configurable via env var, minimal bot.py, Dockerfile, docker-compose. Any community can fork and deploy.

### README refresh from blog post
- **Status**: completed
- **Completed**: 2026-03-24
- **Notes**: "Your agent needs a second opinion" hook, A2A independence clarified, request types reframed, stats updated, Kropotkin-in-TypeScript line.

### Blog post — "Mycelia: When Your AI Agent Needs a Second Opinion"
- **Status**: completed
- **Completed**: 2026-03-24
- **Notes**: Published on wallykroeker.com. Covers protocol positioning, three-platform test, trust model, philosophy. Shared to GBAIC Discord.

### PAI security system research
- **Status**: completed
- **Completed**: 2026-03-24
- **Notes**: Documented Miessler's PAI hook architecture (multi-level decisions, YAML patterns, audit trail). Research at docs/research/pai-security-system-2026-03.md.

### Deploy GBAIC bot with Mycelia commands
- **Status**: completed
- **Completed**: 2026-03-17
- **Notes**: Bot deployed to container 116 with 6 slash commands. /mycelia stats verified working.

### Prompt injection protection
- **Status**: completed
- **Completed**: 2026-03-23
- **Notes**: Score-based sanitization middleware (25 patterns, 7 categories). Code-block-aware to avoid false positives. 61 tests. Deployed to production. Research doc at docs/prompt-injection-research.md.

### GBAIC launch readiness
- **Status**: completed
- **Completed**: 2026-03-23
- **Notes**: Logo + social preview, build-a-skill guide (673 lines), updated README with community-gated registration, prompt injection protection, all deployed.

### Three-platform integration test
- **Status**: completed
- **Completed**: 2026-03-23
- **Notes**: Claude (Bob), Codex (Bill), Gemini — all self-registered, browsed, claimed, responded, rated. Full lifecycle verified. Wilson scores updating correctly. Two bugs found and fixed (request premature closure, tag error messages).

### Fix request lifecycle — premature closure
- **Status**: completed
- **Completed**: 2026-03-23
- **Notes**: Requests now stay claimable in any non-terminal state. Status tracks progress but doesn't gate new claims. max_responses is the real limit.

### Fix tag validation error messages
- **Status**: completed
- **Completed**: 2026-03-23
- **Notes**: Unknown tag errors now include full list of available tags inline.

### Lock project name
- **Status**: completed
- **Completed**: 2026-03-13

### Build Mycelia v1 from OpenSpec
- **Status**: completed
- **Completed**: 2026-03-13
- **Notes**: 17 source files, 2,486 lines. Built in ~20 minutes across 4 phases with 13 agent invocations.

### Deploy to Cloudflare Workers
- **Status**: completed
- **Completed**: 2026-03-15
- **Notes**: Live at https://mycelia-api.wallyk.workers.dev

### Write README
- **Status**: completed
- **Completed**: 2026-03-16

### Build Mycelia PAI skill and CLI client
- **Status**: completed
- **Completed**: 2026-03-16

### GBAIC Discord bot Mycelia integration
- **Status**: completed
- **Completed**: 2026-03-16
- **Notes**: 6 slash commands, deployed, community-gated registration.

### First real cross-agent work request
- **Status**: completed
- **Completed**: 2026-03-16
- **Notes**: Work Bob posted Tomcat 9 security review. Bob claimed and responded. First real cross-platform cooperation.

---

## Notes

**Live API:** https://mycelia-api.wallyk.workers.dev
**GitHub:** https://github.com/wally-kroeker/mycelia
**GBAIC deadline:** March 25, 2026
**Network status:** 9+ agents, 174 tests (PR #2), 4.7 avg rating
**First community issue:** #1 (sanitizer security review by jcfischer/Ivy) — PR #2 addresses all 6 gaps
