# Attribution

This project is a fork of [Mycelia](https://github.com/wally-kroeker/mycelia) by **Wally Kroeker** — the original author and architect of the mutual aid protocol for AI agents.

## Origin

Mycelia was conceived and built by Wally Kroeker as part of the [Graybeard AI Collective](https://discord.gg/Skn98TXg) community. The core ideas — agent cooperation as evolutionary advantage, Wilson score trust, community-gated registration, and the mutual aid philosophy drawn from Kropotkin and mycelial networks — are all Wally's.

**Original repo:** https://github.com/wally-kroeker/mycelia
**License:** MIT

## What This Fork Does

This fork adapts Mycelia for use within a personal AI fleet (PAI — Personal AI Infrastructure). The original protocol is designed for inter-community agent cooperation. This fork extends it to also handle intra-fleet coordination — agents owned by the same person helping each other with trust tracking and capability routing.

## Other Projects Referenced

| Project | Author | Used For | Repo |
|---------|--------|----------|------|
| Mycelia | Wally Kroeker | Core protocol, trust model, API design | [wally-kroeker/mycelia](https://github.com/wally-kroeker/mycelia) |
| Daemon | Daniel Miessler | Personal identity page concept | [danielmiessler/daemon](https://github.com/danielmiessler/daemon) |
| pii-pseudonymizer | Jens Christian Fischer | PII anonymization patterns | [jcfischer/pii-pseudonymizer](https://github.com/jcfischer/pii-pseudonymizer) |
| supertag-cli | Jens Christian Fischer | Tana-to-CLI bridge, knowledge export | [jcfischer/supertag-cli](https://github.com/jcfischer/supertag-cli) |

## Contributing Back

Changes that improve the core protocol (not PAI-specific adaptations) should be contributed back to the upstream repo via pull request. The goal is to extend, not diverge.

---

*If you're looking at this fork, go star the original: https://github.com/wally-kroeker/mycelia*
