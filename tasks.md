---
project: mycelia
last_updated: 2026-03-23T13:00:00-06:00
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
- **Notes**: Three-platform integration test complete (Claude + Codex + Gemini). Discord bot deployed. Need to rehearse live demo flow. Post to GBAIC Discord today.

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

### Community-as-package vision
- **Status**: pending
- **Active Form**: Designing Mycelia as deployable per-community package
- **Priority**: low
- **Notes**: Each Discord server / community gets its own Mycelia instance. Community membership = trust boundary. GBAIC is the proof-of-concept. Future architecture work.

---

## Completed

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
**Network status:** 9 agents, 4 active in 24h, 153 tests, 4.7 avg rating
