# opencode-self-improving-skills

An [opencode](https://opencode.ai) plugin that adds a **Hermes-style self-improvement loop** — the opencode port of [`UniM0cha/claude-self-improving-skills`](https://github.com/UniM0cha/claude-self-improving-skills) (Claude Code) + [`okdk7788/skill-evolution`](https://github.com/okdk7788/skill-evolution) (Claude Code companion), fused into a single TypeScript plugin because opencode's plugin model is natively JS/TS.

Modeled on [Nous Research's Hermes Agent](https://hermes-agent.org/) self-evolution mechanism.

## What it does

A 6-stage loop runs **entirely in the background**, no user intervention required to fire:

1. **TRIGGER** — every LLM call, `experimental.chat.system.transform` injects an advisory. When the session has done substantial work (≥12 tool calls AND ≥2 file edits) and nothing's been distilled yet, the advisory surfaces `[자기개선 트리거]` telling the agent to distill.

2. **REVIEW** — the sibling `skill-distiller` skill (loaded via the `skill` tool) holds the decision procedure: patch existing > patch umbrella > add supporting file > create new class-level skill only as last resort.

3. **STORE** — writes go to `~/.config/opencode/skills/<name>/SKILL.md`. `tool.execute.before` backs up the prior file; `tool.execute.after` validates frontmatter and rolls back on corruption.

4. **DISCOVER** — opencode rescans the skills dir at session start; new skills appear automatically next session.

5. **MEASURE** — `session.idle` records outcome (success/failure proxy) per learned skill used this session, by scanning the last 30 message parts for `is_error` tool results or user-correction phrases (Korean + English). Stored in `skill_outcomes.json`. This is the **GEPA reward signal** that the upstream acquisition-only plugin was missing.

6. **EVOLVE** — `pickEvolutionCandidate()` runs on every chat turn. When a learned skill crosses `use ≥ 2 AND fail ≥ 1`, the advisory surfaces `[진화 후보]` and the agent autonomously calls `optimize_skill(name=…)` to run a GEPA-style loop: gather failure traces → generate candidate rewrites → judge against rubric → Pareto-select → diff for **human approval** (never auto-applied).

## Install

### From this repo (headless / TUI)

```bash
# 1. clone into your opencode plugins directory
git clone https://github.com/okdk7788/opencode-self-improving-skills.git \
  ~/.config/opencode/plugins/self-improving-skills

# 2. copy the companion skills
cp -r ~/.config/opencode/plugins/self-improving-skills/skills/* \
  ~/.config/opencode/skills/
```

opencode auto-loads local plugins from `~/.config/opencode/plugins/` at startup — no `opencode.json` change needed. Restart opencode and the loop is live.

### Verify

After restart, ask the agent: *"call the `evolution_status` tool"*. It should return JSON with `total_skills`, `ranking`, `top_candidate`. If `total_skills === 0`, that's correct — no skills have been distilled yet.

## Custom tools exposed

The plugin registers these tools (callable by the agent, no user prompt needed for the autonomous ones):

| Tool | Autonomous? | Purpose |
|---|---|---|
| `distill_skill` | ✅ (via system-prompt nudge) | Trigger the distillation procedure |
| `curator_status` | on-demand | Show learned skills + usage + idle/stale states |
| `optimize_skill` | ✅ (via evolution-candidate nudge) | Run GEPA-style evolution for one skill |
| `evolution_status` | on-demand | Show outcome stats + optimization ranking |
| `mark_skill_optimized` | internal | Stamp `optimized_at` after applying a rewrite |

## Skills shipped

Two companion skills under `skills/`:

- **`skill-distiller`** — acquisition axis. Decision procedure for capturing reusable techniques as `SKILL.md`. Includes anti-patterns (one-off narratives, environment-specific workarounds, negative tool claims) and the frontmatter format contract.
- **`optimize-skill`** — evolution axis. GEPA-style measured improvement grounded in failure traces. 5-stage: collect evidence → generate candidates → judge (LLM-as-judge) → Pareto-select → human-gated apply.

Both skills carry `metadata.provenance: self-improving-skills` so the plugin's curator counter can find them.

## State

All persistent state lives under `~/.config/opencode/self-improve/`:

```
self-improve/
├── skill_usage.json         # per-skill use/view/patch counts + state machine
├── skill_outcomes.json      # per-skill ok/fail outcomes + fail_signals + optimized_at
├── nudge_state.json         # per-session counters + nudged_at + outcome_recorded
├── curator_state.json       # last_run timestamp + run_count
├── logs/                    # reserved for future curator log output
└── backups/                 # auto-backups of every SKILL.md edit (10 per skill max)
```

## Configuration (env vars)

| Var | Default | Purpose |
|---|---|---|
| `SIS_DISTILL_THRESHOLD` | `12` | Tool calls in a session before distillation nudge fires |
| `SIS_MIN_FILE_EDITS` | `2` | File edits required (filters out pure read/search turns) |
| `SIS_CURATE_MIN_SKILLS` | `8` | Learned-skill count for curation hint |
| `SIS_CURATE_INTERVAL_DAYS` | `7` | Days between auto-curator hints |

The evolution trigger has hard-coded thresholds (`use ≥ 2`, `fail ≥ 1`, 24h cooldown) — open an issue if you want them configurable.

## How this maps to the Claude Code originals

| Claude Code | opencode | Notes |
|---|---|---|
| `Stop` hook (nudge) | `experimental.chat.system.transform` | Fires every LLM call, more frequent than Claude's per-turn Stop |
| `SessionStart` hook | same hook | First call seeds the curator clock |
| `PreToolUse Write\|Edit` (backup) | `tool.execute.before` | SKILL.md auto-backup |
| `PostToolUse Write\|Edit` (validate/rollback) | `tool.execute.after` | Frontmatter check + atomic rollback |
| `Stop` hook (outcome recorder) | `event: session.idle` | Records success/failure per skill used |
| `skill-distiller` subagent | `skill-distiller` skill | opencode: skills ARE the subagent mechanism |
| `/distill-skill`, `/optimize-skill`, `/evolution-status`, `/curator-status` slash commands | custom tools | Same procedures, different invocation surface |

## Why TypeScript, not Python (like the Claude original)

The Claude originals shell out to Python scripts via bash hooks. opencode plugins are natively TS/JS — writing the logic in TS means:
- No external Python dependency, no shell-out overhead
- Direct file I/O via Node `fs`
- Direct SDK access (`client.session.messages()`) for outcome detection
- One language, one runtime, easier to maintain

## Design principles (inherited from upstream)

- **Never auto-commit.** Distillation logic is automatic; the actual SKILL.md write passes through validation+rollback. Evolution logic is automatic; the actual rewrite requires human approval.
- **Declining is a valid outcome.** Most sessions produce nothing worth capturing. The plugin's anti-pattern list filters one-off narratives, environment-specific workarounds, and negative tool claims.
- **Coarse but honest attribution.** Outcome is a "did the segment end clean?" signal, not proof of causation. Failures are only counted *after* a skill's use.
- **No data ⇒ no evolution.** Without outcome traces, `optimize_skill` stops rather than guessing.

## License

MIT — same as both upstream repos.

## Acknowledgments

- [`UniM0cha/claude-self-improving-skills`](https://github.com/UniM0cha/claude-self-improving-skills) (이정윤 / samton-inc) — the original acquisition + curator loop for Claude Code
- [`okdk7788/skill-evolution`](https://github.com/okdk7788/skill-evolution) — the GEPA-style evolution companion for Claude Code
- [Nous Research Hermes Agent](https://hermes-agent.org/) — the conceptual source for self-evolving agents with DSPy + GEPA
