# World ID AgentKit — Research Notes

**Date captured:** 2026-03-18
**Sources:**
- https://world.org/world-id
- https://arstechnica.com/ai/2026/03/world-id-wants-you-to-put-a-cryptographically-unique-human-identity-behind-your-ai-agents/
- https://world.org/blog/announcements/now-available-agentkit-proof-of-human-for-the-agentic-web
- https://techcrunch.com/2026/03/17/world-launches-tool-to-verify-humans-behind-ai-shopping-agents/
- https://www.coindesk.com/tech/2026/03/17/sam-altman-s-world-teams-up-with-coinbase-to-prove-there-is-a-real-person-behind-every-ai-transaction

## What Happened

World (Sam Altman / Tools for Humanity) launched **AgentKit** (March 2026) — a developer toolkit that lets AI agents carry cryptographic proof they're backed by a verified human via World ID (iris-scan-based identity).

## How It Works

1. **Iris scan via Orb hardware** → encrypted biometric code → World ID on phone
2. **Zero-knowledge proofs** → platforms verify "real human" without seeing personal data
3. **Cryptographic delegation** → one verified human can delegate identity to multiple AI agents
4. **Agents prove human backing** without revealing the human's identity

## Key Details

- **Scale:** ~18 million verified humans across 160+ countries
- **Integration:** x402 protocol (Coinbase + Cloudflare) — HTTP 402 Payment Required standard for agentic commerce
- **Use cases:** Rate limiting per-person (not per-bot), agentic commerce, ticket purchases, API access caps
- **Partnerships:** Coinbase (x402 Foundation), Cloudflare (Agent SDK integration)
- **Market sizing:** Agentic commerce projected $3-5 trillion by 2030

## Controversies

- Banned or investigated in 10+ countries (Kenya, Spain, Portugal, Hong Kong, South Korea)
- Global South targeting — offered crypto tokens for iris scans
- Centralized biometric data via proprietary hardware
- Spain ordered mandatory iris data deletion
- Kenya's High Court ruled collection violated data protection laws

## Relevance to Mycelia

### Where They Overlap
- Both solving "who's behind this agent?" — World via biometrics, Mycelia via community trust
- Both addressing agent identity in multi-agent systems
- Both care about one-human-to-many-agents mapping

### Where They Differ

| | World ID / AgentKit | Mycelia |
|---|---|---|
| **Trust source** | Biometric verification (iris scan) | Earned through cooperation (Wilson score) |
| **Identity model** | Cryptographic proof of human | Community-gated registration (Discord) |
| **Philosophy** | Enterprise identity infrastructure | Mutual aid commons |
| **Privacy trade-off** | Iris scan → ZK proof (controversial) | No biometrics, social trust |
| **Scale target** | Billions (global identity layer) | Communities (GBAIC, then organic growth) |
| **Revenue model** | VC-funded, token-based | Open source, no token |
| **Hardware dependency** | Requires Orb device for verification | None |

### Strategic Implications for Mycelia

1. **Validates the problem space.** Sam Altman putting resources behind "human identity for agents" confirms this is a real market need. Mycelia doesn't need to solve the same problem the same way, but it validates our thesis.

2. **Mycelia is the complement, not competitor.** World ID answers "is there a human behind this agent?" Mycelia answers "is this agent good at what it claims?" Identity ≠ competence. A verified human can still run a terrible agent.

3. **Potential integration point.** World ID as an optional registration signal — agents with World ID verification get a badge or trust boost, but it's not required. The community gate (Discord) serves the same purpose at GBAIC scale.

4. **Our differentiation is philosophy.** World is enterprise infrastructure with VC funding and iris scanners. Mycelia is mutual aid with open-source code and community governance. In a world where both exist, they serve different communities and values.

5. **The x402 protocol is interesting.** HTTP 402 for agent payments is a protocol-level standard. If agentic commerce needs payments, it also needs trust. Mycelia's trust scores could inform x402 decisions — "this agent has 0.8 trust, accept the payment" vs "this agent has 0.2 trust, require escrow."
