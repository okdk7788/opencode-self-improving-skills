/**
 * self-improving-skills — opencode port of the Hermes-style self-improvement loop.
 *
 * Originally a Claude Code plugin (UniM0cha/claude-self-improving-skills) +
 * companion skill-evolution (okdk7788/skill-evolution). Ported to opencode's
 * TS plugin model with the same 4-stage loop:
 *
 *   1. TRIGGER   — `experimental.chat.system.transform` injects an advisory
 *                  when the session has done substantial work that hasn't been
 *                  distilled yet. (Equivalent of Claude Code's Stop hook nudge +
 *                  SessionStart advisory, fused because opencode has neither.)
 *   2. REVIEW    — the `skill-distiller` skill (sibling SKILL.md) holds the
 *                  decision procedure. The agent invokes it via the `skill`
 *                  tool when the advisory fires or the user asks.
 *   3. STORE     — writes go to `~/.config/opencode/skills/<name>/SKILL.md`.
 *                  `tool.execute.before` backs up the prior file; `.after`
 *                  validates frontmatter and rolls back on corruption.
 *   4. DISCOVER  — opencode rescans the skills dir at session start; new
 *                  skills appear automatically next session.
 *
 * Plus the GEPA-style evolution axis from skill-evolution:
 *   5. MEASURE   — `session.idle` records outcome (success/failure proxy) per
 *                  learned skill used this session, into skill_outcomes.json.
 *   6. EVOLVE    — `optimize_skill` tool + `optimize-skill` skill run a
 *                  reflective rewrite→judge→pareto→diff loop, human-gated.
 *
 * Config (env vars):
 *   SIS_DISTILL_THRESHOLD   tool calls in a session before nudge (default 12)
 *   SIS_MIN_FILE_EDITS      file edits required (default 2)
 *   SIS_CURATE_MIN_SKILLS   learned-skill count for curation hint (default 8)
 *   SIS_CURATE_INTERVAL_DAYS  days between auto-curator hints (default 7)
 */

import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import * as path from "path"
import * as os from "os"
import * as fs from "fs"

// ────────────────────────────────────────────────────────────────────────────
// Constants
// ────────────────────────────────────────────────────────────────────────────

const HOME = os.homedir()
const SKILLS_DIR = path.join(HOME, ".config", "opencode", "skills")
const STATE_DIR = path.join(HOME, ".config", "opencode", "self-improve")
const USAGE_PATH = path.join(STATE_DIR, "skill_usage.json")
const OUTCOME_PATH = path.join(STATE_DIR, "skill_outcomes.json")
const NUDGE_PATH = path.join(STATE_DIR, "nudge_state.json")
const BACKUP_DIR = path.join(STATE_DIR, "backups")
const CURATOR_STATE = path.join(STATE_DIR, "curator_state.json")

const PROVENANCE_KEY = "self-improving-skills"
const EDIT_TOOLS = new Set(["write", "edit"])
const SKILL_MARKER = "skill-distiller"

function envInt(name: string, def: number): number {
  const v = process.env[name]
  if (!v) return def
  const n = parseInt(v, 10)
  return Number.isFinite(n) ? n : def
}

const DISTILL_THRESHOLD = envInt("SIS_DISTILL_THRESHOLD", 12)
const MIN_FILE_EDITS = envInt("SIS_MIN_FILE_EDITS", 2)
const RENUDGE_INTERVAL = envInt("SIS_RENUDGE_INTERVAL", 20)
const CURATE_MIN_SKILLS = envInt("SIS_CURATE_MIN_SKILLS", 8)
const CURATE_INTERVAL_DAYS = envInt("SIS_CURATE_INTERVAL_DAYS", 7)

// ────────────────────────────────────────────────────────────────────────────
// State helpers — atomic JSON I/O
// ────────────────────────────────────────────────────────────────────────────

function ensureDirs(): void {
  for (const d of [STATE_DIR, BACKUP_DIR, path.join(STATE_DIR, "logs")]) {
    try { fs.mkdirSync(d, { recursive: true }) } catch { /* exists */ }
  }
}

function readJSON<T>(file: string, fallback: T): T {
  try {
    const raw = fs.readFileSync(file, "utf-8")
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

function writeJSONAtomic(file: string, data: unknown): void {
  ensureDirs()
  // Unique tmp name per write — concurrent writers (parallel sessions or
  // parallel tool calls) would otherwise share `.tmp` and clobber each other.
  const tmp = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`
  let fd: number | null = null
  try {
    // Use openSync + fsyncSync + closeSync so the tmp is durable before rename.
    // writeFileSync alone does not guarantee the data is on disk before rename
    // completes — a crash between write and rename can leave an empty file.
    fd = fs.openSync(tmp, "w")
    fs.writeFileSync(fd, JSON.stringify(data, null, 2), "utf-8")
    fs.fsyncSync(fd)
    fs.closeSync(fd)
    fd = null
    fs.renameSync(tmp, file)
  } catch {
    if (fd !== null) { try { fs.closeSync(fd) } catch { /* noop */ } }
    try { fs.unlinkSync(tmp) } catch { /* noop */ }
  }
}

function nowIso(): string {
  return new Date().toISOString().replace(/\.\d+Z$/, "Z")
}

function isSkillPath(p: string | undefined | null): boolean {
  if (!p) return false
  const norm = String(p).replace(/\\/g, "/")
  return norm.includes("/.config/opencode/skills/") && norm.endsWith("SKILL.md")
}

function skillNameFromPath(p: string | undefined | null): string | null {
  if (!isSkillPath(p)) return null
  const norm = String(p).replace(/\\/g, "/")
  const idx = norm.lastIndexOf("/")
  if (idx <= 0) return null
  const dir = norm.slice(norm.lastIndexOf("/", idx - 1) + 1, idx)
  return dir || null
}

function learnedSkillNames(): Set<string> {
  const names = new Set<string>()
  try {
    for (const entry of fs.readdirSync(SKILLS_DIR)) {
      if (entry.startsWith(".")) continue
      try {
        const stat = fs.statSync(path.join(SKILLS_DIR, entry, "SKILL.md"))
        if (stat.isFile()) names.add(entry)
      } catch { /* skip */ }
    }
  } catch { /* dir missing */ }
  return names
}

function seedCreatedBy(name: string): "agent" | "user" {
  // Mark as "agent" only if the skill's own frontmatter declares distilled
  // provenance. Otherwise default to "user" so hand-authored skills never end
  // up on the auto-archive path just from being observed.
  try {
    const safe = path.basename(name)
    const fp = path.join(SKILLS_DIR, safe, "SKILL.md")
    const head = fs.readFileSync(fp, "utf-8").slice(0, 2048)
    if (/origin\s*:\s*distilled/.test(head) || head.includes(`provenance: ${PROVENANCE_KEY}`)) {
      return "agent"
    }
  } catch { /* fallthrough */ }
  return "user"
}

// ────────────────────────────────────────────────────────────────────────────
// Usage telemetry — skill_usage.json
// ────────────────────────────────────────────────────────────────────────────

type UsageRecord = {
  use_count: number
  view_count: number
  patch_count: number
  last_used_at: string | null
  last_viewed_at: string | null
  last_patched_at: string | null
  created_at: string
  state: "active" | "stale" | "archived"
  pinned: boolean
  created_by: "agent" | "user" | "team"
  absorbed_into: string | null
}

type UsageStore = {
  _meta: {
    sessions: Record<string, { last_seen_message: string; t: string }>
    nudges: Record<string, { at_message: string; t: string }>
  }
  [skill: string]: UsageRecord | any
}

function emptyUsageRecord(): UsageRecord {
  return {
    use_count: 0,
    view_count: 0,
    patch_count: 0,
    last_used_at: null,
    last_viewed_at: null,
    last_patched_at: null,
    created_at: nowIso(),
    state: "active",
    pinned: false,
    created_by: "agent",
    absorbed_into: null,
  }
}

function loadUsage(): UsageStore {
  const data = readJSON<UsageStore>(USAGE_PATH, {
    _meta: { sessions: {}, nudges: {} },
  })
  if (!data._meta) data._meta = { sessions: {}, nudges: {} }
  if (!data._meta.sessions) data._meta.sessions = {}
  if (!data._meta.nudges) data._meta.nudges = {}
  return data
}

function saveUsage(data: UsageStore): void {
  writeJSONAtomic(USAGE_PATH, data)
}

function bumpUsage(skill: string, kind: "use" | "view" | "patch"): void {
  try {
    // Reject reserved/malicious keys: "_meta" would clobber the store's
    // metadata bag, "__proto__"/"constructor"/"prototype" enable prototype
    // pollution, and any non-string from upstream callers falls back to a
    // no-op rather than corrupting the store.
    if (typeof skill !== "string" || skill.startsWith("_") || skill === "__proto__" || skill === "constructor" || skill === "prototype") {
      return
    }
    const data = loadUsage()
    if (!data[skill] || typeof data[skill] !== "object" || !("use_count" in data[skill])) {
      data[skill] = emptyUsageRecord()
      ;(data[skill] as UsageRecord).created_by = seedCreatedBy(skill)
    }
    const rec = data[skill] as UsageRecord
    if (kind === "use") { rec.use_count++; rec.last_used_at = nowIso() }
    if (kind === "view") { rec.view_count++; rec.last_viewed_at = nowIso() }
    if (kind === "patch") { rec.patch_count++; rec.last_patched_at = nowIso() }
    saveUsage(data)
  } catch { /* best-effort */ }
}

function forgetMissingUsage(existing: Set<string>): void {
  try {
    const data = loadUsage()
    let changed = false
    for (const key of Object.keys(data)) {
      if (key === "_meta") continue
      if (!existing.has(key) && !(data[key] as UsageRecord)?.pinned) {
        // mark absorbed rather than delete (preserves audit trail)
        const rec = data[key] as UsageRecord
        if (rec && rec.state !== "archived") {
          rec.state = "archived"
          rec.absorbed_into = "(deleted)"
          changed = true
        }
      }
    }
    if (changed) saveUsage(data)
  } catch { /* best-effort */ }
}

// ────────────────────────────────────────────────────────────────────────────
// Outcome telemetry — skill_outcomes.json (GEPA reward signal)
// ────────────────────────────────────────────────────────────────────────────

type SkillOutcome = {
  ok: number
  fail: number
  last_outcome_at: string | null
  fail_signals: string[]   // last N reasons (capped)
  sessions: Record<string, "ok" | "fail" | "pending">
}

type OutcomeStore = {
  _meta: {
    version: number
    optimized_at: Record<string, string>
    evolution_nudge_at: Record<string, string>
  }
  skills: Record<string, SkillOutcome>
}

function loadOutcomes(): OutcomeStore {
  const data = readJSON<OutcomeStore>(OUTCOME_PATH, {
    _meta: { version: 1, optimized_at: {}, evolution_nudge_at: {} },
    skills: {},
  })
  if (!data._meta) data._meta = { version: 1, optimized_at: {}, evolution_nudge_at: {} }
  if (!data._meta.optimized_at) data._meta.optimized_at = {}
  if (!data._meta.evolution_nudge_at) data._meta.evolution_nudge_at = {}
  if (!data.skills) data.skills = {}
  return data
}

function saveOutcomes(data: OutcomeStore): void {
  writeJSONAtomic(OUTCOME_PATH, data)
}

function recordOutcome(skill: string, sessionId: string, result: "ok" | "fail", signal?: string): void {
  try {
    const data = loadOutcomes()
    if (!data.skills[skill]) {
      data.skills[skill] = { ok: 0, fail: 0, last_outcome_at: null, fail_signals: [], sessions: {} }
    }
    const rec = data.skills[skill]
    // One session = one outcome. Re-evaluation overwrites.
    const prev = rec.sessions[sessionId]
    if (prev !== result) {
      if (prev === "ok") rec.ok = Math.max(0, rec.ok - 1)
      if (prev === "fail") rec.fail = Math.max(0, rec.fail - 1)
      if (result === "ok") rec.ok++
      if (result === "fail") rec.fail++
      rec.sessions[sessionId] = result
    }
    rec.last_outcome_at = nowIso()
    if (result === "fail" && signal) {
      rec.fail_signals = [signal, ...rec.fail_signals].slice(0, 20)
    }
    saveOutcomes(data)
  } catch { /* best-effort */ }
}

function markOptimized(skill: string): void {
  try {
    const data = loadOutcomes()
    data._meta.optimized_at[skill] = nowIso()
    // Reset the evolution cooldown so the just-optimized version gets a fresh
    // 24h window to accumulate new outcomes before being re-nudged. Without
    // this, the old cooldown timestamp from before the rewrite would still
    // gate the next nudge, causing over-eager re-nudging of a skill whose
    // new version hasn't been exercised yet.
    data._meta.evolution_nudge_at[skill] = nowIso()
    saveOutcomes(data)
  } catch { /* best-effort */ }
}

const EVOLUTION_NUDGE_COOLDOWN_HOURS = 24
const EVOLUTION_MIN_USE = 2
const EVOLUTION_MIN_FAIL = 1

function pickEvolutionCandidate(): string | null {
  try {
    const data = loadOutcomes()
    const usage = loadUsage()
    const now = Date.now()
    let best: { name: string; use: number; fail: number; priority: number } | null = null
    for (const [name, o] of Object.entries(data.skills)) {
      if (o.ok + o.fail < 1) continue
      const u = (usage[name] as UsageRecord) ?? emptyUsageRecord()
      if (u.use_count < EVOLUTION_MIN_USE) continue
      if (o.fail < EVOLUTION_MIN_FAIL) continue
      const last = data._meta.evolution_nudge_at[name]
      if (last) {
        const ageHours = (now - Date.parse(last)) / 3_600_000
        if (ageHours < EVOLUTION_NUDGE_COOLDOWN_HOURS) continue
      }
      const total = o.ok + o.fail
      const smoothed = (o.fail + 1) / (total + 2)
      const priority = u.use_count * smoothed
      if (!best || priority > best.priority) {
        best = { name, use: u.use_count, fail: o.fail, priority }
      }
    }
    if (!best) return null
    data._meta.evolution_nudge_at[best.name] = nowIso()
    saveOutcomes(data)
    return (
      `[진화 후보] '${best.name}' 스킬 — use=${best.use}, fail=${best.fail}/${best.use}. ` +
      "사용자가 자진해서 묻기 전에 능동적으로 `optimize_skill(name=\"" + best.name + "\")` 툴을 호출해 " +
      "GEPA식 개선 절차(실패 트레이스 수집 → 후보 변형 → 판정 → diff 제안)를 시작하세요. " +
      "단, 적용은 반드시 사용자 승인 후 (human-gated)."
    )
  } catch {
    return null
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Nudge state — per-session "did we nudge? did we record outcome?"
// ────────────────────────────────────────────────────────────────────────────

type NudgeState = {
  sessions: Record<string, {
    tool_calls: number
    file_edits: number
    nudged_at: string | null
    last_nudge_tool_calls: number
    last_file_edit_ts: string | null
    devlog_nudged_at: string | null
    outcome_recorded: boolean
    skills_used: string[]
    last_updated: string
  }>
}

function loadNudge(): NudgeState {
  const data = readJSON<NudgeState>(NUDGE_PATH, { sessions: {} })
  if (!data.sessions) data.sessions = {}
  return data
}

function saveNudge(data: NudgeState): void {
  writeJSONAtomic(NUDGE_PATH, data)
}

function getSessionState(sessionId: string): NudgeState["sessions"][string] {
  const data = loadNudge()
  if (!data.sessions[sessionId]) {
    data.sessions[sessionId] = {
      tool_calls: 0,
      file_edits: 0,
      nudged_at: null,
      last_nudge_tool_calls: 0,
      last_file_edit_ts: null,
      devlog_nudged_at: null,
      outcome_recorded: false,
      skills_used: [],
      last_updated: nowIso(),
    }
    saveNudge(data)
  }
  return data.sessions[sessionId]
}

function updateSessionState(sessionId: string, patch: Partial<NudgeState["sessions"][string]>): void {
  try {
    const data = loadNudge()
    if (!data.sessions[sessionId]) {
      data.sessions[sessionId] = {
        tool_calls: 0,
        file_edits: 0,
        nudged_at: null,
        last_nudge_tool_calls: 0,
        last_file_edit_ts: null,
        devlog_nudged_at: null,
        outcome_recorded: false,
        skills_used: [],
        last_updated: nowIso(),
      }
    }
    Object.assign(data.sessions[sessionId], patch, { last_updated: nowIso() })
    // prune old sessions (keep most recent 200)
    const entries = Object.entries(data.sessions)
    if (entries.length > 200) {
      entries.sort((a, b) => (a[1].last_updated < b[1].last_updated ? 1 : -1))
      data.sessions = Object.fromEntries(entries.slice(0, 200))
    }
    saveNudge(data)
  } catch { /* best-effort */ }
}

// ────────────────────────────────────────────────────────────────────────────
// Backup / validate SKILL.md edits
// ────────────────────────────────────────────────────────────────────────────

function backupSkill(filePath: string): string | null {
  try {
    if (!fs.existsSync(filePath)) return null
    const name = skillNameFromPath(filePath) || "unknown"
    const stamp = new Date().toISOString().replace(/[:.]/g, "")
    const dest = path.join(BACKUP_DIR, `${name}.${stamp}.SKILL.md`)
    fs.copyFileSync(filePath, dest)
    const prefix = `${name}.`
    const all = fs.readdirSync(BACKUP_DIR)
      .filter((f: string) => f.startsWith(prefix) && f.endsWith(".SKILL.md"))
      .sort()
    while (all.length > 10) {
      const old = all.shift()
      if (old) try { fs.unlinkSync(path.join(BACKUP_DIR, old)) } catch { /* noop */ }
    }
    return dest
  } catch { /* best-effort */ return null }
}

function validateSkillFrontmatter(filePath: string): { ok: boolean; error?: string } {
  try {
    let content = fs.readFileSync(filePath, "utf-8")
    // Strip UTF-8 BOM (EF BB BF → U+FEFF when decoded) — some editors emit
    // it, and `content.startsWith("---")` returns false if BOM is present,
    // causing every BOM-prefixed SKILL.md to be rejected and rolled back.
    if (content.charCodeAt(0) === 0xFEFF) content = content.slice(1)
    if (!content.startsWith("---")) {
      return { ok: false, error: "Missing YAML frontmatter opening `---`" }
    }
    const end = content.indexOf("\n---", 3)
    if (end < 0) {
      return { ok: false, error: "Missing YAML frontmatter closing `---`" }
    }
    const fm = content.slice(3, end)
    if (!/^\s*name\s*:\s*\S+/m.test(fm)) {
      return { ok: false, error: "Frontmatter missing `name:`" }
    }
    if (!/^\s*description\s*:\s*\S+/m.test(fm)) {
      return { ok: false, error: "Frontmatter missing `description:`" }
    }
    const nameMatch = fm.match(/^\s*name\s*:\s*"?([^\s"]+)"?/m)
    if (nameMatch) {
      const n = nameMatch[1]
      if (n.length > 64) return { ok: false, error: `name too long (${n.length} > 64)` }
      if (/--/.test(n) && /(^-|-$|--)/.test(n)) {
        return { ok: false, error: `name has invalid hyphens: ${n}` }
      }
    }
    const sizeKB = Buffer.byteLength(content, "utf-8") / 1024
    if (sizeKB > 30) {
      return { ok: false, error: `SKILL.md too large (${sizeKB.toFixed(1)}KB > 30KB)` }
    }
    return { ok: true }
  } catch (e: any) {
    return { ok: false, error: `validate error: ${e?.message ?? String(e)}` }
  }
}

function rollbackSkill(filePath: string, backupPath: string | null): void {
  try {
    if (backupPath && fs.existsSync(backupPath)) {
      fs.copyFileSync(backupPath, filePath)
    } else {
      // No backup existed (this was a create); delete the broken file
      try { fs.unlinkSync(filePath) } catch { /* noop */ }
    }
  } catch { /* best-effort */ }
}

// ────────────────────────────────────────────────────────────────────────────
// Outcome detection — does the message stream signal failure?
// ────────────────────────────────────────────────────────────────────────────

const CORRECTION_PATTERNS = [
  /\b(아니야|아닙니다|틀렸|틀린|잘못|다시\s*해|다시\s*해줘|그거\s*아니|그건\s*아니|아니라|고쳐|수정해)\b/,
  /\b(no|wrong|incorrect|not\s+that|that'?s?\s+wrong|try\s+again|do\s+it\s+again|fix\s+this|that'?s?\s+not\s+right)\b/i,
  /\b(still\s+broken|still\s+failing|still\s+doesn'?t\s+work|여전히\s+안|아직\s+안)\b/i,
]

function looksLikeCorrection(text: string): boolean {
  if (!text || text.length > 5000) return false
  return CORRECTION_PATTERNS.some(re => re.test(text))
}

// ────────────────────────────────────────────────────────────────────────────
// Curator state
// ────────────────────────────────────────────────────────────────────────────

type CuratorState = { last_run: string | null; run_count: number; last_summary?: any }

function loadCurator(): CuratorState {
  return readJSON<CuratorState>(CURATOR_STATE, { last_run: null, run_count: 0 })
}

function saveCurator(s: CuratorState): void {
  writeJSONAtomic(CURATOR_STATE, s)
}

const DISTILL_PROCEDURE = [
  "DECISION PROCEDURE — follow in order, prefer the earliest that applies:",
  "",
  "STEP 1 — Patch a directly-relevant existing skill if one fits (Edit its SKILL.md).",
  "STEP 2 — Otherwise, patch a broader 'umbrella' skill if a class-level one exists.",
  "STEP 3 — Add a supporting file (references/, templates/, scripts/) under an existing skill if the knowledge is bulky.",
  "STEP 4 — Create a NEW class-level skill ONLY as a last resort. Check ~/.config/opencode/skills/ for collisions first.",
  "",
  "ANTI-PATTERNS — do NOT capture:",
  "  - One-off task narratives ('how I fixed the build on date X').",
  "  - Environment-dependent workarounds.",
  "  - Negative tool claims ('tool Z is broken').",
  "  - Things already obvious from docs or covered by an existing skill.",
  "",
  "SKILL.md FORMAT:",
  "  ---",
  "  name: <lowercase-hyphenated, class-level, <=64 chars>",
  "  description: <third-person situation match, <=500 chars, slightly pushy>",
  "  metadata:",
  "    provenance: self-improving-skills",
  "    origin: distilled",
  "  ---",
  "  # <Title>",
  "  ## When this applies",
  "  ## The technique",
  "  ## Gotchas",
  "",
  "After writing: confirm frontmatter is valid (the tool.execute.after hook will roll back on failure).",
  "Report in ONE line: patched vs created, the skill name, the one-line technique.",
].join("\n")

const GEPA_PROCEDURE = [
  "GEPA-STYLE EVOLUTION — Hermes self-evolution port",
  "",
  "1. COLLECT EVIDENCE — read the SKILL.md fully. Use session_search to find sessions where this skill was used.",
  "   For each match, inspect messages after the skill was loaded — look for is_error tool results, user corrections, retries.",
  "   Distill 3-6 concrete failure patterns. This is your Actionable Side Information.",
  "",
  "2. GENERATE CANDIDATES — write 2-3 alternative SKILL.md versions, each addressing different failure patterns:",
  "   A: tighten trigger conditions in description to fire less wrongly",
  "   B: add missing steps/edge-cases/verification in the body",
  "   C: trim bloat for clarity (same coverage, less tokens)",
  "   Each candidate MUST preserve: valid frontmatter, the skill's original purpose.",
  "",
  "3. JUDGE — score each (and the original) 0-5 on:",
  "   - failure_coverage: does it actually prevent the documented failures? (most important)",
  "   - trigger_precision: fires when it should, not when it shouldn't",
  "   - clarity_actionability: situation-match prose, not defensive commands",
  "   - cost: size/tokens (smaller is better)",
  "   Be honest. If the original is already Pareto-best, 'no improvement' is correct.",
  "",
  "4. SELECT — Pareto-optimal candidate. Quality (coverage+precision+clarity) first, cost as tiebreak.",
  "",
  "5. APPLY (human-gated) — show the user:",
  "   - The diff vs current",
  "   - Which failure each change targets",
  "   - Wait for explicit approval. Then Edit the SKILL.md (the tool.execute.before/after hooks will backup + validate automatically).",
  "   - After applying, call `mark_skill_optimized(name=<target>)` to stamp optimized_at.",
  "",
  "PRINCIPLES:",
  "  - Never auto-commit. Mutation is automatic; file rewrite requires human approval.",
  "  - Preserve meaning: evolve to do the same thing better, not change the skill's identity.",
  "  - No data, no evolution: if outcome traces are empty, stop — don't guess.",
]

// ────────────────────────────────────────────────────────────────────────────
// Plugin export
// ────────────────────────────────────────────────────────────────────────────

export const SelfImprovingSkills: Plugin = async ({ client }) => {
  ensureDirs()

  // In-memory per-session counters (also persisted in nudge_state.json)
  const counters: Record<string, { tool_calls: number; file_edits: number }> = {}
  // Track which SKILL.md backups we made this call, so .after can roll back
  const backupsThisCall: Record<string, string | null> = {}

  function bumpCounters(sessionId: string, tool: string, _args: any): void {
    if (!counters[sessionId]) {
      const persisted = getSessionState(sessionId)
      counters[sessionId] = {
        tool_calls: persisted.tool_calls,
        file_edits: persisted.file_edits,
      }
    }
    counters[sessionId].tool_calls++
    if (EDIT_TOOLS.has(tool)) {
      counters[sessionId].file_edits++
    }
  }

  return {
    // ── Inject advisory context into every chat turn ──────────────────────
    // This is the opencode analogue of Claude Code's SessionStart + Stop hook:
    // it runs on every LLM call so the agent always sees current loop state.
    "experimental.chat.system.transform": async (_input, output) => {
      try {
        const learned = countLearnedSkills()
        const lines: string[] = []

        lines.push(
          "[self-improving-skills] 자기개선 루프 활성. " +
          "복잡한 작업·까다로운 디버깅·새 기법 발견을 끝냈고 그것이 재사용 가능하다면, " +
          "`skill` 도구로 `skill-distiller` 스킬을 로드해 절차를 따르거나 " +
          "`distill_skill` 커스텀 툴을 호출해 증류를 트리거하세요. " +
          "결과는 ~/.config/opencode/skills/<name>/SKILL.md 로 저장됩니다."
        )
        lines.push(
          "학습 스킬을 사용하다가 낡았거나 틀린 내용을 발견하면 시키기를 기다리지 말고 " +
          "그 자리에서 해당 SKILL.md 를 patch 하세요 — 유지보수되지 않는 스킬은 부채가 됩니다."
        )
        if (learned > 0) {
          lines.push(`현재 학습된 스킬 ${learned}개가 ~/.config/opencode/skills 에 누적되어 있습니다.`)
        }

        // Curation hint (time-based, event-gated like the upstream plugin)
        const cur = loadCurator()
        if (cur.last_run === null) {
          // first tick — seed the clock, defer
          saveCurator({ ...cur, last_run: nowIso() })
        } else if (learned >= CURATE_MIN_SKILLS) {
          const ageDays = (Date.now() - Date.parse(cur.last_run)) / 86_400_000
          if (ageDays >= CURATE_INTERVAL_DAYS) {
            lines.push(
              `[큐레이터] 마지막 정리 후 ${Math.floor(ageDays)}일 경과 — ` +
              "`curator_status` 툴로 현황을 보거나 사용자에게 `/curate-skills` " +
              "실행을 제안하세요 (stale/archive 대상 식별)."
            )
          }
        }

        // Pending nudge? (substantial work this session, not yet distilled)
        const sessions = loadNudge().sessions
        const currentSid = resolveSessionId(_input)
        let nudgeTarget: { sid: string; s: NudgeState["sessions"][string] } | null = null
        if (currentSid) {
          const my = sessions[currentSid]
          if (my && my.tool_calls >= DISTILL_THRESHOLD && my.file_edits >= MIN_FILE_EDITS) {
            const sinceLast = my.tool_calls - (my.last_nudge_tool_calls ?? 0)
            if (!my.nudged_at || sinceLast >= RENUDGE_INTERVAL) {
              nudgeTarget = { sid: currentSid, s: my }
            }
          }
        } else {
          const cutoff = Date.now() - 30 * 60 * 1000
          const recent = Object.entries(sessions)
            .filter(([, s]) => {
              if (s.tool_calls < DISTILL_THRESHOLD || s.file_edits < MIN_FILE_EDITS) return false
              if (Date.parse(s.last_updated) < cutoff) return false
              const sinceLast = s.tool_calls - (s.last_nudge_tool_calls ?? 0)
              return !s.nudged_at || sinceLast >= RENUDGE_INTERVAL
            })
            .sort(([, a], [, b]) => Date.parse(b.last_updated) - Date.parse(a.last_updated))
          if (recent.length > 0) nudgeTarget = { sid: recent[0][0], s: recent[0][1] }
        }
        if (nudgeTarget) {
          const { sid, s } = nudgeTarget
          lines.push(
            `[자기개선 트리거] 세션 ${sid.slice(0, 12)}…에서 도구 호출 ${s.tool_calls}회·파일 편집 ${s.file_edits}회 ` +
            "누적됐고 아직 스킬로 증류되지 않았습니다. 이번 작업에 재사용 가능한 기법이 있다면 " +
            "`distill_skill` 툴을 호출하거나 `skill-distiller` 스킬을 로드해 증류하세요. " +
            "일회성 작업이라면 사용자에게 한 줄로 이유를 알리고 넘어가세요 — 조용히 무시하지 마세요."
          )
          updateSessionState(sid, { nudged_at: nowIso(), last_nudge_tool_calls: s.tool_calls })
        }

        // DEVLOG staleness check: if ≥3 file edits this session and DEVLOG.md
        // hasn't been touched since the last edit, nudge the agent to update it.
        if (currentSid) {
          const my = sessions[currentSid]
          if (my && my.file_edits >= 3 && my.last_file_edit_ts && !my.devlog_nudged_at) {
            try {
              const devlogPath = path.join(process.cwd(), "DEVLOG.md")
              if (fs.existsSync(devlogPath)) {
                const devlogMtime = fs.statSync(devlogPath).mtimeMs
                if (devlogMtime < Date.parse(my.last_file_edit_ts)) {
                  lines.push(
                    `[DEVLOG 알림] 이번 세션에서 파일 편집 ${my.file_edits}회 수행했지만 DEVLOG.md가 업데이트되지 않았습니다. ` +
                    "AGENTS.md 규칙에 따라 작업 세션 마무리 시 DEVLOG.md에 항목을 추가하세요 " +
                    "(날짜 / 무엇을 / 왜 이 방식 / 한계·개선 후보)."
                  )
                  updateSessionState(currentSid, { devlog_nudged_at: nowIso() })
                }
              }
            } catch { /* best-effort */ }
          }
        }

        const evoHint = pickEvolutionCandidate()
        if (evoHint) {
          lines.push(evoHint)
        }

        output.system.push(lines.join("\n\n"))
      } catch {
        // Advisory is best-effort — never break the chat
      }
    },

    // ── Backup before SKILL.md edits ──────────────────────────────────────
    "tool.execute.before": async (input, output) => {
      try {
        if (!EDIT_TOOLS.has(input.tool)) return
        // input.args is not in the strict type but is present at runtime —
        // cast to any so we can read filePath without fighting the type def.
        const fp = (input as any).args?.filePath as string | undefined
        if (!fp || !isSkillPath(fp)) return
        backupsThisCall[input.callID] = backupSkill(fp)
        const name = skillNameFromPath(fp)
        if (name) bumpUsage(name, "view")
      } catch {
        // best-effort — never block the tool
      }
    },

    // ── Validate after SKILL.md edits + count all tool calls ──────────────
    "tool.execute.after": async (input, _output) => {
      try {
        try {
          const debugLogPath = path.join(STATE_DIR, "logs", "plugin-debug.log")
          const rawSid = (input as any)?.sessionID
          fs.appendFileSync(debugLogPath, JSON.stringify({
            ts: new Date().toISOString(),
            tool: input.tool,
            sessionID: rawSid,
            sessionID_type: typeof rawSid,
            sessionID_length: typeof rawSid === "string" ? rawSid.length : null,
            input_keys: Object.keys(input),
            metadata_keys: (input as any)?.metadata ? Object.keys((input as any).metadata) : [],
          }) + "\n")
        } catch {}

        // opencode 1.17+ sometimes passes undefined/truncated sessionID;
        // resolveSessionId (module-scope helper) handles multiple sources.
        const sid = resolveSessionId(input)

        bumpCounters(sid, input.tool, input.args)
        const c = counters[sid]
        if (c) {
          updateSessionState(sid, {
            tool_calls: c.tool_calls,
            file_edits: c.file_edits,
          })
        }

        if (input.tool === "skill" && typeof input.args?.name === "string") {
          const learned = learnedSkillNames()
          const name = input.args.name
          if (learned.has(name)) {
            bumpUsage(name, "use")
            const state = getSessionState(sid)
            if (!state.skills_used.includes(name)) {
              updateSessionState(sid, {
                skills_used: [...state.skills_used, name],
                outcome_recorded: false,
              })
            }
          }
        }

        if (EDIT_TOOLS.has(input.tool)) {
          updateSessionState(sid, { last_file_edit_ts: nowIso(), devlog_nudged_at: null })
        }

        // Validate SKILL.md after edit/write
        if (EDIT_TOOLS.has(input.tool)) {
          const fp = input.args?.filePath as string | undefined
          if (fp && isSkillPath(fp)) {
            const v = validateSkillFrontmatter(fp)
            const name = skillNameFromPath(fp)
            if (!v.ok) {
              rollbackSkill(fp, backupsThisCall[input.callID] ?? null)
              try {
                await client.app.log({
                  body: {
                    service: "self-improving-skills",
                    level: "error",
                    message: `Rolled back ${name ?? "skill"}: ${v.error}`,
                  },
                })
              } catch { /* logging best-effort */ }
              // Throw to surface the failure to the agent
              throw new Error(
                `[self-improving-skills] SKILL.md validation failed and was rolled back: ${v.error}. ` +
                `Fix the frontmatter and try again. Backup retained at ${BACKUP_DIR}/.`
              )
            }
            // Valid — bump patch_count, forget-missing cleanup, prune marker
            if (name) {
              bumpUsage(name, "patch")
              forgetMissingUsage(learnedSkillNames())
            }
          }
        }
      } finally {
        delete backupsThisCall[input.callID]
      }
    },

    // ── Session idle: record outcomes for skills used this session ────────
    event: async ({ event }) => {
      // Resolve session ID from multiple plausible payload shapes — opencode
      // event properties vary across versions and we never want sessionId to
      // be undefined (which would create a bogus "undefined" key in
      // nudge_state.json and silently break outcome tracking).
      const sessionId = resolveEventSessionId(event)
      // Cast event.type to string — opencode's strict event type union does
      // not currently include "session.end", but it can fire at runtime and
      // we use it as a cleanup trigger for in-memory per-session state.
      const eventType = event.type as string
      if (eventType === "session.idle" || eventType === "session.end") {
        // Free per-session in-memory state to prevent unbounded growth of
        // counters / backupsThisCall over the plugin's lifetime.
        if (sessionId) {
          delete counters[sessionId]
        }
        if (eventType === "session.end") return
      }
      if (eventType !== "session.idle") return
      if (!sessionId || typeof sessionId !== "string") return
      try {
        const state = getSessionState(sessionId)
        if (state.outcome_recorded) return
        const used = state.skills_used ?? []
        if (used.length === 0) {
          // Do NOT set outcome_recorded here. session.idle fires every turn,
          // not just at session end. If we burn the flag now, future skill
          // uses in this session will never be recorded — which permanently
          // disables the GEPA evolution loop. Just return and try again on
          // the next idle.
          return
        }
        let failureSignal: string | null = null
        try {
          const resp: any = await (client as any).session.messages({ path: { id: sessionId }, query: { limit: 30 } })
          const msgs = (resp?.data ?? resp ?? []) as Array<{ info: any; parts: any[] }>
          const recent = msgs.flatMap(m => (m?.parts ?? [])).slice(-30)
          for (const p of recent) {
            const t = p?.type
            if (t === "tool") {
              const err = p?.error || p?.metadata?.error
              if (err) { failureSignal = `tool_error: ${String(err).slice(0, 200)}`; break }
              if (p?.state === "error") { failureSignal = "tool_state_error"; break }
            } else if (t === "text") {
              const txt = p?.text ?? ""
              if (looksLikeCorrection(txt)) { failureSignal = "user_correction"; break }
            }
          }
        } catch { /* reading messages is best-effort */ }

        const result: "ok" | "fail" = failureSignal ? "fail" : "ok"
        for (const skill of used) {
          recordOutcome(skill, sessionId, result, failureSignal ?? undefined)
        }
        updateSessionState(sessionId, { outcome_recorded: true })
      } catch {
        // best-effort — never crash the event handler
      }
    },

    // ── Custom tools ───────────────────────────────────────────────────────
    tool: {
      // Trigger distillation: returns the procedure for the agent to follow
      distill_skill: tool({
        description:
          "Trigger the self-improvement loop: distill reusable techniques from the current session into a learned skill. " +
          "Returns the decision procedure (patch vs create, anti-patterns, SKILL.md format). " +
          "Call this after complex work, debugging wins, or new technique discoveries — OR when the system advisory tells you the work warrants distillation. " +
          "Never use for one-off tasks (specific PR, specific bug, environment-specific workaround).",
        args: {
          context: tool.schema.string().describe(
            "Optional: free-text hint about what technique to focus on, or which existing skill to update."
          ),
        },
        async execute(args, context) {
          const learned = learnedSkillNames()
          const existing = Array.from(learned).sort()
          const transcriptHint = `This session's transcript can be read via session_read/session_messages using sessionID ${context.sessionID ?? "(unknown)"}.`
          return {
            output: JSON.stringify({
              distilled_skill_directory: SKILLS_DIR,
              existing_learned_skills: existing,
              existing_count: existing.length,
              procedure: DISTILL_PROCEDURE,
              transcript_hint: transcriptHint,
              user_hint: args.context ?? null,
              note: "If nothing meets the bar, write nothing and tell the user why in one line. Declining is a valid, common outcome.",
            }, null, 2),
          }
        },
      }),

      curator_status: tool({
        description:
          "Show the current state of the learned-skill library: usage counts, idle/stale/archived statuses, " +
          "and candidates for curation (archival of unused skills). Use when reviewing skill health or before /curate-skills.",
        args: {},
        async execute() {
          const data = loadUsage()
          const learned = learnedSkillNames()
          forgetMissingUsage(learned)
          const rows: any[] = []
          for (const name of Array.from(learned).sort()) {
            const rec = (data[name] as UsageRecord) ?? emptyUsageRecord()
            const last = rec.last_used_at ?? rec.last_viewed_at ?? rec.created_at
            const idleDays = last ? Math.floor((Date.now() - Date.parse(last)) / 86_400_000) : null
            rows.push({
              name,
              state: rec.state ?? "active",
              use: rec.use_count ?? 0,
              view: rec.view_count ?? 0,
              patch: rec.patch_count ?? 0,
              created_by: rec.created_by ?? "user",
              idle_days: idleDays,
              pinned: !!rec.pinned,
            })
          }
          const cur = loadCurator()
          return {
            output: JSON.stringify({
              total_learned: learned.size,
              curator_last_run: cur.last_run,
              curator_run_count: cur.run_count,
              skills: rows,
              backup_dir: BACKUP_DIR,
              hint: rows.length === 0
                ? "No learned skills yet. Run `distill_skill` after complex work to create one."
                : "Stale (>30d idle) or archived skills can be cleaned up via /curate-skills.",
            }, null, 2),
          }
        },
      }),

      optimize_skill: tool({
        description:
          "GEPA-style skill evolution: gather failure traces for a skill → generate candidate rewrites → judge against rubric → pick Pareto-best → return diff for human approval. " +
          "Call when `evolution_status` shows a skill with high use but high failure rate. " +
          "Returns the procedure; the agent executes the actual rewrite as Edit (which passes through the backup/validate hooks).",
        args: {
          name: tool.schema.string().describe(
            "Skill name to optimize. If empty, the agent should call `evolution_status` first to pick the top candidate."
          ),
        },
        async execute(args) {
          const target = (args.name ?? "").trim()
          if (!target) {
            return {
              output: JSON.stringify({
                error: "missing_skill_name",
                hint: "Call `evolution_status` first to pick the top candidate, then re-invoke with its name.",
              }),
            }
          }
          // Defense against path traversal: `target` comes from LLM tool args,
          // so `../../etc/SKILL.md` would otherwise let an attacker read any
          // file named SKILL.md on the system via this tool's readFileSync.
          if (!/^[a-z0-9][a-z0-9-]*$/i.test(target)) {
            return {
              output: JSON.stringify({
                error: "invalid_skill_name",
                hint: `Skill name must match /^[a-z0-9][a-z0-9-]*$/i — got "${target.slice(0, 64)}"`,
              }),
            }
          }
          const skillPath = path.join(SKILLS_DIR, target, "SKILL.md")
          const resolved = path.resolve(skillPath)
          if (!resolved.startsWith(SKILLS_DIR + path.sep)) {
            return { output: JSON.stringify({ error: "path traversal blocked" }) }
          }
          if (!fs.existsSync(skillPath)) {
            return { output: JSON.stringify({ error: `Skill not found: ${skillPath}` }) }
          }
          const outcomes = loadOutcomes()
          const outcome = outcomes.skills[target]
          const usage = (loadUsage()[target] as UsageRecord) ?? null
          return {
            output: JSON.stringify({
              target,
              skill_path: skillPath,
              current_skill: fs.readFileSync(skillPath, "utf-8"),
              outcome_stats: outcome
                ? { ok: outcome.ok, fail: outcome.fail, last_outcome_at: outcome.last_outcome_at, fail_signals: outcome.fail_signals }
                : { ok: 0, fail: 0, last_outcome_at: null, fail_signals: [] },
              usage_stats: usage
                ? { use: usage.use_count, view: usage.view_count, patch: usage.patch_count, state: usage.state }
                : null,
              procedure: GEPA_PROCEDURE.join("\n"),
              post_apply_reminder: "After the user approves and you apply the Edit, call `mark_skill_optimized` with this skill's name.",
            }, null, 2),
          }
        },
      }),

      evolution_status: tool({
        description:
          "Show outcome stats (success/failure counts) and optimization-candidate ranking for learned skills. " +
          "Use this before optimize_skill to pick the right target, or to monitor skill health.",
        args: {},
        async execute() {
          const usage = loadUsage()
          const outcomes = loadOutcomes()
          const learned = learnedSkillNames()
          const rows: any[] = []
          for (const name of Array.from(learned).sort()) {
            const u = (usage[name] as UsageRecord) ?? emptyUsageRecord()
            const o = outcomes.skills[name] ?? { ok: 0, fail: 0, fail_signals: [] }
            const total = o.ok + o.fail
            const failRate = total > 0 ? o.fail / total : 0
            const smoothed = (o.fail + 1) / (total + 2)
            const priority = u.use_count * smoothed
            const optimized = outcomes._meta.optimized_at[name] ?? null
            rows.push({
              name,
              use: u.use_count,
              ok: o.ok,
              fail: o.fail,
              fail_pct: total > 0 ? Math.round(failRate * 100) : null,
              priority: Math.round(priority * 100) / 100,
              optimized_at: optimized,
            })
          }
          rows.sort((a, b) => b.priority - a.priority)
          return {
            output: JSON.stringify({
              total_skills: learned.size,
              ranking: rows,
              top_candidate: rows[0]?.priority > 0 && (rows[0]?.fail ?? 0) > 0
                ? { name: rows[0].name, reason: `use=${rows[0].use}, fail=${rows[0].fail}/${rows[0].ok + rows[0].fail}` }
                : null,
              hint: rows.length === 0 || rows.every(r => r.use === 0)
                ? "No skills have been used yet. Outcomes accumulate as learned skills get used and sessions go idle."
                : "If top_candidate is set, consider calling `optimize_skill` with its name.",
            }, null, 2),
          }
        },
      }),

      mark_skill_optimized: tool({
        description:
          "INTERNAL — call this after applying an optimized rewrite to a skill, so the plugin records the optimization timestamp. " +
          "Do not call directly; the optimize_skill procedure instructs when to use it.",
        args: {
          name: tool.schema.string().describe("Skill name that was just optimized."),
        },
        async execute(args) {
          const name = (args.name ?? "").trim()
          if (!name) return { output: JSON.stringify({ error: "missing name" }) }
          markOptimized(name)
          return { output: JSON.stringify({ ok: true, skill: name, optimized_at: nowIso() }) }
        },
      }),
    },
  }
}

function resolveSessionId(inp: any): string {
  // opencode 1.17+ sometimes passes undefined/truncated sessionID in tool
  // hook payloads; resolve from multiple sources. Returns "_unknown_session"
  // (a stable string key) when nothing is available — never undefined, so
  // downstream map access can't produce a bogus "undefined" key.
  const direct = inp?.sessionID
  if (typeof direct === "string" && direct.length >= 8) return direct
  const metaSid = inp?.metadata?.sessionID
  if (typeof metaSid === "string" && metaSid.length >= 8) return metaSid
  const metaSession = inp?.metadata?.session
  if (typeof metaSession === "string" && metaSession.length >= 8) return metaSession
  const envSid =
    process.env.OPOCODE_SESSION_ID ||
    process.env.OPENCODE_SESSION_ID ||
    process.env.SESSION_ID
  if (typeof envSid === "string" && envSid.length >= 8) return envSid
  return "_unknown_session"
}

function resolveEventSessionId(event: any): string | null {
  const candidates = [
    event?.properties?.sessionID,
    event?.properties?.sessionId,
    event?.properties?.session?.id,
    event?.properties?.session,
    event?.payload?.sessionID,
    event?.payload?.sessionId,
    event?.sessionID,
    event?.sessionId,
  ]
  for (const c of candidates) {
    if (typeof c === "string" && c.length >= 8) return c
  }
  return null
}

function countLearnedSkills(): number {
  let n = 0
  try {
    for (const entry of fs.readdirSync(SKILLS_DIR)) {
      if (entry.startsWith(".") || entry.startsWith("_")) continue
      const fp = path.join(SKILLS_DIR, entry, "SKILL.md")
      try {
        const head = fs.readFileSync(fp, "utf-8").slice(0, 2048)
        if (head.includes(PROVENANCE_KEY)) n++
      } catch { /* skip */ }
    }
  } catch { /* dir missing */ }
  return n
}

export default SelfImprovingSkills
