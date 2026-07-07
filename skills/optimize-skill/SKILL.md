---
name: optimize-skill
description: GEPA-style measured evolution of a learned skill under ~/.config/opencode/skills. Use this skill when the `evolution_status` tool or `optimize_skill` tool returns a skill with high use_count AND non-zero failure rate, OR when the user asks to evolve/improve/optimize/refine a specific skill, OR when the self-improving-skills plugin's `optimize_skill` tool was called (it returns the procedure pointer; this skill provides the actual reasoning). This is the companion axis to `skill-distiller` — distiller ACQUIRES skills, this skill IMPROVES them by reflective mutation grounded in failure traces.
metadata:
  provenance: self-improving-skills
  origin: distilled
---

# Optimize Skill — GEPA-style reflective evolution

This is the "measured evolution" axis of the self-improvement loop. The `skill-distiller` skill captures new techniques; this skill improves existing ones using actual failure data. Modeled on Nous Research Hermes Agent's GEPA (genetic-pareto prompt evolution).

## 0. Target selection

- If the user named a skill, use that.
- If the caller is `optimize_skill` tool with an empty name, call `evolution_status` first to get the ranking. The top candidate is your target if its `priority > 0`.
- If `evolution_status` returns no candidate with `priority > 0` → tell the user "outcome 데이터가 아직 없습니다. 학습 스킬이 실제로 쓰이면서 세션이 idle 상태가 되면 데이터가 쌓입니다." and stop.

Read the target skill:
- `read ~/.config/opencode/skills/<name>/SKILL.md` (full content)
- Call `optimize_skill(name="<target>")` tool — it returns the procedure, current skill content, and outcome/usage stats.

## 1. Collect evidence (traces → "why did it fail?")

GEPA's core is not *that* it failed, but *why*. Find sessions where this skill was used:

- `session_search(query="<skill name>")` — opencode's session search will return matching sessions with excerpts.
- `session_search(query="<specific phrase from the skill description>")` — find broader matches.

For each matching session, use `session_read(session_id="<id>", include_todos=false)` to read it. After the point where the skill was loaded, inspect for:
- `is_error: true` tool results
- `state: "error"` tool parts
- User correction phrases: Korean (`아니야`, `틀렸`, `다시 해`, `그거 아니`, `고쳐`) or English (`no`, `wrong`, `incorrect`, `try again`, `still broken`)
- Retries of the same operation

Distill **3 to 6 concrete failure patterns**. Each pattern should be a sentence: "When X happens, the skill told us to do Y, but Z actually worked." This is your **Actionable Side Information** — it directs the mutations in step 2.

If traces are thin (new skill, few uses), fall back to weaknesses visible in the SKILL.md itself:
- Vague trigger conditions in the description
- Missing edge cases in the body
- Excessive `MUST ALWAYS` defensive phrasing
- Stale commands/paths/versions

## 2. Generate candidate mutations

Write **2 to 3 alternative versions** of the SKILL.md, each targeting different failure patterns. Use genuinely different strategies — don't just tweak one direction:

- **A: Tighten trigger precision.** Edit the description so it fires when it should and not when it shouldn't. Address over-trigger failures.
- **B: Strengthen body.** Add missing steps, edge cases, verification commands. Address under-coverage failures.
- **C: Trim bloat.** Same coverage, fewer tokens. Address clarity/cost failures.

Each candidate MUST:
- Preserve valid frontmatter (`name`, `description`, `metadata.provenance: self-improving-skills`)
- Preserve the skill's original purpose (evolve to do the same thing better, not change identity)
- Stay under size limits: body ≤ 15KB recommended, description ≤ 500 chars (each char is permanent context cost)

## 3. Judge (LLM-as-judge against the rubric)

Score each version (and the **original**) 0–5 on:
- **failure_coverage** — does it actually prevent the documented failures? (most important)
- **trigger_precision** — fires when it should, not when it shouldn't
- **clarity_actionability** — situation-match prose, not defensive command lists
- **cost** — size/tokens (smaller is better)

Be honest. If the original is already Pareto-best, **"no improvement"** is the correct answer — don't manufacture change.

## 4. Pareto selection

Pick the Pareto-optimal candidate: quality (coverage + precision + clarity) as primary, cost as tiebreak. If the original dominates, do nothing and tell the user "현재 버전이 이미 Pareto 최적이라 변경하지 않습니다."

## 5. Apply (human-gated)

Show the user:
- The diff between the chosen candidate and the current SKILL.md
- For each changed region, **which failure pattern it targets**
- Wait for explicit user approval. **Do not auto-apply.** (Hermes' "never direct commit, always PR review" principle.)

After approval:
- Use `edit` (or `write` if wholesale replacement is cleaner) on `~/.config/opencode/skills/<name>/SKILL.md`.
- The plugin's `tool.execute.before` hook will **automatically back up** the previous version.
- The plugin's `tool.execute.after` hook will **automatically validate** frontmatter and roll back on failure.
- After successful edit, call `mark_skill_optimized(name="<name>")` — this stamps `optimized_at` so future `evolution_status` runs can compare before/after outcomes.

Summarize in 2–3 lines: what changed, which failures it targets, what to watch for next.

## Design principles (do not violate)

- **Never auto-commit.** Mutation/evaluation/selection are automatic; the actual file rewrite requires human approval.
- **Preserve meaning.** Evolution makes the same purpose work better — it does not change the skill's identity.
- **No data, no evolution.** If outcome traces are empty AND you can't find concrete weaknesses in the SKILL.md, stop. Don't guess.
- **Honest judgment.** "No improvement needed" is a valid and common outcome. Manufacturing change to look productive is a bug.

## Optional: quantitative DSPy + GEPA engine

The above is a dependency-free "Claude-as-optimizer" reflective loop. For quantitative optimization with eval datasets, [`intertwine/dspy-agent-skills`](https://github.com/intertwine/dspy-agent-skills) (DSPy 3.2 + GEPA) can be wired in as opt-in. Requires API keys + eval sets + per-run cost. Default is the reflective loop above.

## Communication style

Match the user's language. Korean in → Korean out. Brief, concrete, no ceremony.
