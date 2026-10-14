# Changelog

## Unreleased (0.1.1)

Fixed:

- Permission adjudication now scrubs configured secret literals from the
  task prompt before sending evidence, matching the route and outcome
  paths. Previously the permission path sent the raw prompt, so a prompt
  containing a secret literal (e.g. a pasted key) would leave the machine
  unredacted in that request. (`src/permission.ts`, `docs/design.md` §8)
- Score answers from the Decisions API are the probability-weighted
  expectation over the levels (e.g. `score 3.9` with `P(3)=0.06, P(4)=0.93`),
  not an integer index. The validator now accepts any finite number in
  `[0, criteria.length)`; integer-only validation rejected legitimate
  fractional scores whenever the level distribution was split.
  (`src/client.ts`, `docs/design.md` §10)
- A low-confidence `finish` no longer advances `planning → executing`.
  Previously `action === "finish"` short-circuited the confidence check, so a
  `finish` below `PI_JEV_OUTCOME_CONFIDENCE` could start execution, violating
  the design rule that only an explicit AND high-confidence finish may
  transition. Such verdicts now settle with the `low_confidence` reason.
  (`src/outcome.ts`, `docs/design.md` §5)
- Evidence second layer now omits tool results that embed credential contexts
  (a `Bearer`/`Authorization` header or a private-key block) wholesale, so a
  benign read of an innocently-named file cannot leak a token through outcome
  evidence. Narrow patterns only — git SHAs and hash constants are kept.
  (`src/evidence.ts`, `docs/design.md` §8)
- The route decision log records when a routed tier switch was actually
  skipped (`tier=<tier> (skipped: <reason>)` — e.g. `not_scoped`,
  `manual_override`) instead of logging the bare routed tier as if it had
  taken effect. (`extensions/jev.ts`)
- README accuracy pass: the MATH-500 section now positions the benchmark as
  evaluating the JEV-based three-tier routing design used by pi-jev-governor
  and states that it covers model routing only — the plugin's planning,
  permission, and outcome-governance features are outside the benchmark's
  scope; the acceptance case count is 23 (H01–H22 plus the H20b variant); the
  easy-tier share is phrased as ~22–23% of all problems; the pinned-install
  example no longer cites a tag that does not exist yet. (`README.md`)
- MATH-500 benchmark wording finalized across docs: the benchmark is described
  as evaluating the JEV-based three-tier routing design used by
  pi-jev-governor (fixed-model baseline comparison, model routing only),
  replacing earlier wordings that attributed the benchmark to a specific
  operating setup. (`README.md`, `README.zh-CN.md`,
  `docs/math500-final-report-20261003.md`)

Added:

- Acceptance harness: `scripts/mock-jev.mjs` (deterministic local JEV
  Decisions API with scripted answers, sequential outcome scripts, and
  per-decision-kind fault injection), `scripts/run-acceptance.sh` (23
  end-to-end cases — H01–H22 plus the H20b variant — with per-case evidence
  and a `RESULTS.md` summary), and `scripts/jevlog.py` (decision-log
  assertion helper).
- `docs/acceptance-tests.md`: two-track acceptance protocol (automated
  H-series + manual TUI screenshot S-series) with the smoke.md M1–M7 mapping.
- `.env.local.example` template and `scripts/run.sh` launcher that source
  local configuration (`.env.local` is git-ignored).
- Single bilingual `README.md` (English + 简体中文 with anchor navigation);
  `README.zh-CN.md` is a pointer stub.
- README restructured as a project landing page: hero result line, project
  status, workflow diagram for the four decision points, and a slimmed
  MATH-500 section; new figures in `docs/assets/` (English and 简体中文
  variants of the results card and workflow diagram, plus a cost-change chart
  with the ±2.6% rerun-noise band). Reference SVG sources live in
  `docs/assets/src/`.
- README restructured to the final landing-page order: hero result card →
  project status → benchmark → how-it-works (new detailed workflow diagram)
  → demo → quick start → configuration → safety & privacy → development;
  `README.md` is now English-only with the full 简体中文 version in
  `README.zh-CN.md` (replacing the pointer stub); demo GIFs render as a 2×2
  grid; the visible configuration is slimmed to the key variables with the
  full reference in `<details>`; the earlier four-node workflow figures were
  retired in favor of `docs/assets/governor-workflow.png`. (`README.md`,
  `README.zh-CN.md`, `CHANGELOG.md`, `docs/assets/`)

## 0.1.0 (2026-10-08)

Initial release.

- Decision 1 `plan_strategy` + Decision 2 `tier`: one JEV request at
  `before_agent_start`; model switching with manual-override detection,
  scoped-model, context-window, and image-input guards; read-only plan phase
  for `plan_only` / `plan_then_execute`.
- Decision 3 permission gate at `tool_call`: phase gate, deterministic
  allow/deny rules, JEV adjudication with human confirmation fallback
  (fail-closed without UI). Concurrent confirmations are serialized; approval
  caches are task-scoped (`allow_once` / `allow_exact_for_task` /
  `allow_tool_for_task`); credential-bearing commands stay local while clean
  commands are sanitized before being sent; permissions stay enforced in
  degraded mode; unexpected handler failures become sanitized fail-closed
  blocks.
- Decision 4 outcome judge at `agent_before_settle`: finish / retry / replan
  with a bounded corrections budget shared across planning and execution,
  phase-tagged logs, structured settle reasons, evidence redaction, and
  opt-in `git diff --stat` evidence. Plans are validated by the outcome judge
  before execution starts.
- Settle continuation returns state and `custom_message` drafts atomically;
  state is restored from the active branch on session start and tree
  navigation.
- `pi --no-jev` disables the plugin; `/jev on|off` controls the session.
- JSONL decision logs: per-session files with mode 0600 under a mode-0700
  platform state directory (`PI_JEV_LOG_DIR` overrides).
- Unit tests plus real-lifecycle integration tests against pi's public APIs.
