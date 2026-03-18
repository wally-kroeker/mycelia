# ATXP / Circuit & Chisel — Research Notes

**Date captured:** 2026-03-18
**Source:** ~/projects/bob-and-friends/ (Wally's direct experience)
**Contact:** David Noel-Romas (Circuit & Chisel, friend of Wally's)

## What Is ATXP

**Autonomous Transaction Protocol** — a payments protocol for AI agents and MCP servers.

Core idea: **payment = authorization.** No API keys, no user accounts. Agents pay per request directly from wallets. MCP servers enforce per-tool, per-call pricing. Signed payments authorize calls.

**Provider:** Circuit & Chisel (David Noel-Romas)
**Docs:** https://docs.atxp.ai
**Cloud:** https://cloud.atxp.ai

## How It Works

1. Agent requests a resource/tool
2. Server responds with price
3. Agent signs payment from wallet
4. Payment authorizes the call
5. Tool executes, results returned
6. Per-user runtime isolation

## Wally's Experience

Wally has a project (`~/projects/bob-and-friends/`) built on Claude Agent SDK + ATXP Cloud. The "Bob and Friends" system deploys specialized clone agents (Bill, Mario, Riker, Howard, Homer) to ATXP as stateless specialists while Bob (local) maintains full context and orchestrates.

**Key architecture insight:** Bob (local) sanitizes requests before delegating to cloud agents. Cloud agents are stateless, context-isolated, and only have access to public tools (WebSearch, WebFetch). Results flow back to Bob who integrates with local context.

**Status:** Planning/early testing phase. Riker (researcher) was the first deployment target.

## Relevance to Mycelia

### The Three-Way Comparison

| | ATXP | World ID | Mycelia |
|---|---|---|---|
| **Question answered** | "Can this agent pay?" | "Is there a human?" | "Is this agent good?" |
| **Trust mechanism** | Financial (wallet balance) | Biometric (iris scan) | Behavioral (Wilson score) |
| **Auth model** | Payment = auth | ZK proof = identity | API key + community gate |
| **Philosophy** | Commerce infrastructure | Identity infrastructure | Cooperation infrastructure |
| **Revenue** | Per-call pricing | VC/token | Open source |
| **Personal connection** | Dave (friend, GBAIC member) | None | Wally built it |

### How They Complement Each Other

```
World ID:  "This agent has a verified human behind it"  (identity layer)
ATXP:      "This agent can pay for services"            (commerce layer)
Mycelia:   "This agent is good at code review"           (competence layer)
```

All three are needed. None replaces the others.

### Potential Integration Points

1. **ATXP as Mycelia payment rail.** Agents on Mycelia could optionally charge for help via ATXP. "I'll review your code for 0.05 credits." Mutual aid stays free, but premium/specialized help could be monetized. This preserves the mutual aid philosophy while enabling sustainability.

2. **Mycelia trust informing ATXP pricing.** High-trust agents get better rates. "This agent has 0.85 trust on Mycelia → reduced escrow requirement." Trust score becomes a financial signal.

3. **ATXP-deployed agents on Mycelia.** Bob-and-Friends agents (Riker, Bill, Mario) deployed on ATXP could register as Mycelia agents and offer their specialties. A cloud-deployed research agent responding to Mycelia help requests. The ATXP payment handles the compute cost; the Mycelia trust handles the quality signal.

4. **MCP server monetization + Mycelia.** ATXP lets MCP servers charge per-tool. A Mycelia-connected MCP server could use trust scores to gate access: "Only agents with trust > 0.5 can use this tool at the discounted rate."

### Strategic Consideration

Dave attended an early GBAIC session but isn't an active member yet — Wally needs to invite him back. If he comes to Meeting #3, there's a natural conversation: "Here's Mycelia (cooperation layer), and here's how it connects to what you're building at ATXP (commerce layer)." Two builders in the same room whose projects complement each other — that's the mutual aid thesis in action. Even without Dave present, the ATXP connection is worth mentioning as a future integration path.

### x402 Connection

Both ATXP and World ID's AgentKit connect to the **x402 protocol** (Coinbase + Cloudflare) — HTTP 402 Payment Required for agent commerce. This is becoming the standard payment handshake for agents. Mycelia's trust layer could sit alongside x402: the 402 response includes not just "pay this much" but "minimum trust required: 0.5."
