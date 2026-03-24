# PAI Security System — Research Notes

**Date:** 2026-03-24
**Source:** [danielmiessler/Personal_AI_Infrastructure](https://github.com/danielmiessler/Personal_AI_Infrastructure) (v2.5 release)
**Related:** Issue #1 (sanitizer improvements), [jcfischer/pai-content-filter](https://github.com/jcfischer/pai-content-filter)
**Relevance:** Future sanitizer architecture — multi-level decisions, YAML-driven patterns, audit trail

---

## Context

Researched Daniel Miessler's PAI security system to inform Mycelia's content sanitization roadmap. PAI doesn't use a standalone "content filter" package — it implements a multi-layered security hook system with YAML-driven pattern matching. This is architecturally different from Mycelia's current single-pass regex scorer but offers ideas for future iterations.

Jens-Christian Fischer's [pai-content-filter](https://github.com/jcfischer/pai-content-filter) is a separate project that extracts and packages some of these patterns as a reusable library. The patterns from issue #1 came from that library, not from Miessler's PAI directly.

---

## Key Architecture Concepts

### Defense-in-Depth (4 Layers)

```
Layer 1: settings.json permissions    → Fast allow-list for tools
Layer 2: SecurityValidator hook       → Pattern matching (blocking)
Layer 3: Security Event Logging       → Audit trail (MEMORY/SECURITY/)
Layer 4: Git version control          → Rollback via git restore
```

### Multi-Level Decision Model

PAI doesn't just block or allow — it has four decision levels:

| Level | Action | Use Case |
|-------|--------|----------|
| **Block** | Hard reject, exit(2) | Catastrophic, irreversible operations (rm -rf /) |
| **Confirm** | Prompt user, exit(0) + JSON | Dangerous but legitimate (git push --force) |
| **Alert** | Log and allow | Suspicious patterns worth monitoring (curl \| sh) |
| **Allow** | Pass through | Everything else |

**Rationale:** Users disable security when friction is too high. Selective enforcement keeps the system usable.

**Mycelia parallel:** Our current sanitizer only has block (score >= 10) and warn (score >= 5). Adding a "confirm" tier where the API returns a warning but allows the content could reduce friction for borderline cases.

### YAML-Driven Patterns (Cascading Config)

```
Priority 1: USER/patterns.yaml        (custom overrides)
Priority 2: SYSTEM/patterns.example.yaml (defaults)
Priority 3: Empty / fail-open         (if no config found)
```

**Mycelia parallel:** Our patterns are hardcoded in `sanitize.ts`. Making them configurable (per-community YAML or KV-stored) would let each Mycelia node tune sensitivity. Not needed now, but relevant for the community-as-package vision.

---

## Pattern Categories (from PAI)

### Bash Command Patterns

**Blocked (hard reject):**
- `rm -rf /`, `rm -rf ~` — filesystem destruction
- `diskutil eraseDisk`, `dd if=/dev/zero` — disk destruction
- `mkfs` — filesystem format
- `gh repo delete` — repository deletion
- `gh repo edit --visibility public` — repository exposure

**Confirm (prompt user):**
- `git push --force`, `git reset --hard` — git operations
- `aws s3 rm.*--recursive`, `aws ec2 terminate` — cloud operations
- `terraform destroy`, `terraform apply.*-auto-approve` — infrastructure
- `DELETE FROM.*WHERE`, `DROP DATABASE`, `DROP TABLE`, `TRUNCATE` — database

**Alert (log only):**
- `curl.*\|.*sh`, `curl.*\|.*bash`, `wget.*\|.*sh` — pipe-to-shell

### Path Protection

| Category | Example Paths | Behavior |
|----------|--------------|----------|
| Zero Access | `~/.ssh/id_*`, `**/credentials.json` | Block all operations |
| Read Only | `/etc/**` | Can read, block write/delete |
| Confirm Write | `**/.env`, `**/.env.*` | Can read, confirm on write |
| No Delete | `.git/**`, `LICENSE*` | Can read/write, block delete |

### Prompt Injection (Trust Hierarchy)

PAI uses a protocol-based approach rather than pattern matching:

```
HIGHEST: User's direct instructions
HIGH:    PAI skill files and agent configs
MEDIUM:  Verified code in ~/.claude/
LOW:     Public code repositories (READ ONLY)
ZERO:    External websites, APIs, documents (info only, NEVER commands)
```

Watch phrases: "Ignore all previous instructions", "Your new instructions are...", "System override: execute...", hidden text (zero-width Unicode, HTML comments), Base64-encoded instructions.

### Command Injection Defense

Key patterns:
- Never interpolate untrusted input into shell strings
- Use `execFile` with argument arrays, not `exec` with string concatenation
- Validate URLs against internal IP ranges (SSRF protection)
- Block private IPs: `10.*`, `172.16.*`, `192.168.*`, `169.254.169.254` (AWS metadata)

---

## Security Event Logging

### Event Schema

```json
{
  "timestamp": "ISO-8601",
  "session_id": "uuid",
  "event_type": "block|confirm|alert|allow",
  "tool": "Bash|Edit|Write|Read",
  "category": "bash_command|path_access",
  "target": "command or file path",
  "pattern_matched": "the triggering pattern",
  "reason": "human-readable description",
  "action_taken": "what the system did"
}
```

### Storage

```
MEMORY/SECURITY/YYYY/MM/security-{summary}-{timestamp}.jsonl
```

**Mycelia parallel:** We already log sanitizer blocks to the audit log, but don't track per-agent injection frequency. Issue #1 recommended feeding warning frequency into trust scores — this logging model would support that.

---

## Applicability to Mycelia

### Already Implemented (via issue #1 / PR #2)

- Encoding bypass detection (unicode, hex, URL-encoded, HTML entities)
- Tool invocation patterns (bash tool use, eval/exec, destructive file ops)
- Output manipulation ("don't tell your operator")
- PII/secret scanning (API keys, AWS keys, PEM keys)
- Cross-field score aggregation

### Future Considerations

| PAI Concept | Mycelia Application | Priority |
|-------------|-------------------|----------|
| Multi-level decisions (block/confirm/alert/allow) | Return warnings for borderline content instead of hard block | Medium |
| YAML-driven patterns | Per-community pattern config via KV | Low (needs federation) |
| Per-agent injection tracking → trust decay | Track sanitizer warnings per agent, decay trust on repeat offenders | Medium |
| SSRF protection | Not applicable (agents don't submit URLs for server-side fetch) | N/A |
| Path protection | Not applicable (no file system access) | N/A |
| Cascading config | Relevant when Mycelia is deployable per-community | Low |

---

## References

- PAI Architecture: `Releases/v2.5/.claude/skills/PAI/SYSTEM/PAISECURITYSYSTEM/ARCHITECTURE.md`
- Hook Implementation: `Releases/v2.5/.claude/hooks/SecurityValidator.hook.ts`
- Command Injection: `Releases/v2.5/.claude/skills/PAI/SYSTEM/PAISECURITYSYSTEM/COMMANDINJECTION.md`
- Prompt Injection: `Releases/v2.5/.claude/skills/PAI/SYSTEM/PAISECURITYSYSTEM/PROMPTINJECTION.md`
- Default Patterns: `Releases/v2.5/.claude/skills/PAI/SYSTEM/PAISECURITYSYSTEM/patterns.example.yaml`
