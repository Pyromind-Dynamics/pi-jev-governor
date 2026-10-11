<div align="center">

# pi-jev-governor

**[English](#en)** | **[简体中文](#zh)**

</div>

---

<div align="center">

<a id="en"></a>

## English

</div>

A decision governor for the [pi](https://pi.dev) coding agent — routes four critical agent decisions through the JEV Decisions API to add intelligent planning, model routing, permission control, and outcome validation.

### What it does

| Decision | pi event | Result |
|---|---|---|
| `plan_strategy` | `before_agent_start` | `direct`, `plan_only`, or a read-only `plan_then_execute` phase |
| `tier` | `before_agent_start` | `small`, `normal`, or `strong`, with model compatibility guards |
| `permission.action` | `tool_call` | Deterministic rules → JEV adjudication → human/fail-closed fallback |
| `outcome` | `agent_before_settle` | Finish, retry, or replan with a shared correction budget |

- `plan_strategy` and `tier` share a single request. A `plan_then_execute` task makes an additional Outcome request to validate the plan before execution.
- Planning revisions and execution corrections share a hard maximum of **2** automatic corrections.
- Loaded directly by pi. **No bundled runtime dependencies. Does not modify pi itself.**

### Live demo

Four tasks recorded in the pi TUI (launched via `scripts/run.sh --models qwen/qwen3.7-plus,qwen/qwen3.7-flash,qwen/qwen3.7-max`). After each prompt is submitted, watch the bottom status bar (`jev:<phase>/<tier>`) and the model indicator in the bottom-right corner re-route.

**One-line knowledge question → `direct/small`:** the model drops from `qwen3.7-plus` to `qwen3.7-flash`.

<p align="center">
  <img src="https://github.com/qianyuxiang-369/pi-jev-governor/releases/download/demo-media/route-small-flash.gif" alt="Simple Q&A routed to the small tier: the status bar flips from jev:ready to jev:direct/small and the model indicator switches from qwen3.7-plus to qwen3.7-flash" width="600">
</p>

**Routine three-step implementation → `direct/normal`:** back up from `qwen3.7-flash` to `qwen3.7-plus`.

<p align="center">
  <img src="https://github.com/qianyuxiang-369/pi-jev-governor/releases/download/demo-media/route-normal-plus.gif" alt="Three-step stats tool routed to the normal tier: the status bar flips to jev:direct/normal and the model indicator switches to qwen3.7-plus" width="600">
</p>

**Risky multi-consumer refactor → `plan_then_execute/strong`:** a read-only planning phase on `qwen3.7-max` runs before any edit is allowed.

<p align="center">
  <img src="https://github.com/qianyuxiang-369/pi-jev-governor/releases/download/demo-media/plan-then-execute.gif" alt="Risky refactor routed through a read-only planning phase: the status bar flips to jev:planning/strong, the model switches to qwen3.7-max, and only read-only commands run during planning" width="600">
</p>

**Architecture design question → `plan_only/strong`:** the deliverable is analysis only, so pi stays on `qwen3.7-max` without implementing anything.

<p align="center">
  <img src="https://github.com/qianyuxiang-369/pi-jev-governor/releases/download/demo-media/plan-only-strong.gif" alt="Architecture design question routed to plan-only: the status bar flips to jev:plan_only/strong and the model switches to qwen3.7-max" width="600">
</p>

### Benchmarked Results (MATH-500)

**Takeaway: up to 45% cost reduction with no accuracy loss — Jev's measured value here is cost allocation and negligible overhead, not accuracy.** Measured as opencode+jev (with Jev) vs opencode (without Jev) on 458 text problems from HuggingFaceH4/MATH-500 (42 image problems excluded). The benchmark ran on the opencode integration of the same JEV Decisions API, sharing three of pi-jev's four decision points (model routing, permission, outcome); `plan_strategy` is pi-jev-only and was not benchmarked:

| Baseline Config | Jev Routing Config | Accuracy Change | Cost Change |
|---|---|---|---|
| qwen3.8-27b | easy: flash / main: 27b / hard: max | 97.4% → 98.3% | −1.4% |
| qwen3.8-27b | easy: 27b / main: flash / hard: max | 98.0% → 99.1% | **−45%** |
| qwen3.8-flash | easy: flash / main: 27b / hard: max | 91.5% → 98.7% | +51% |
| qwen3.7-plus | easy: flash / main: plus / hard: max | 98.3% → 98.7% | −13% |

**Key Findings**:

- **No accuracy loss**: all four comparisons maintain or improve accuracy (+0.4 to +1.1pp on the strong baselines, within run-to-run noise)
- **Up to 45% cost reduction**: The key is using cheaper models for the main tier—switching main to flash saves 45%, keeping main unchanged saves only 1.4%; larger price gaps yield greater savings (3.7 series with ~10× price gap saves 13%)
- **Minimal Jev overhead**: Decision cost is only 1.4–2.6% of total, latency P50 0.6-0.7s (P95 ≤1.6s), less than 5% of total latency
- **Lightweight governance**: Model Router judges ~22–23% of all problems easy and routes them to the cheaper model (zero accuracy loss on that subset); Outcome Judge and Permission Gate rarely trigger on pure Q&A tasks (they need coding tasks for validation); the hard tier never fired on this dataset
- **Attribution boundary**: the single statistically significant gain (flash baseline, 91.5% → 98.7%) is attributed by the report's ablation to the agent/scaffold switch, not model routing

> 📊 Full test report and methodology: [docs/math500-final-report-20261003.md](docs/math500-final-report-20261003.md) (originally published in the [opencode-jev](https://github.com/qianyuxiang-369/opencode-jev) repo)

### Install

```bash
# From Git (tracks the default branch)
pi install git:github.com/qianyuxiang-369/pi-jev-governor

# Pinned to a tagged release (none exists yet; usable after the first tag):
# pi install git:github.com/qianyuxiang-369/pi-jev-governor@<tag>

# From local checkout
pi install ./pi-jev-governor
```

npm publishing is planned but has not happened yet — until then, use the Git or local install.

Try without installing:

```bash
pi -e ./pi-jev-governor
```

> **Requires pi 0.87.1+** — both 0.87.1 and 1.1.0 pass the full acceptance suite (54 assertions each; evidence in [`evidence/acceptance-20261008-163809`](evidence/acceptance-20261008-163809) for 0.87.1 and [`evidence/acceptance-20261008-180941`](evidence/acceptance-20261008-180941) for 1.1.0). `@earendil-works/pi-ai` and `@earendil-works/pi-coding-agent` are peer dependencies supplied by pi.

### Configure

At minimum, set the JEV credential and one pi model per tier. The repo provides a `.env.local` template and a launch script:

```bash
cp .env.local.example .env.local   # fill in your keys and models
./scripts/run.sh                   # run from any scratch project directory
```

Manual equivalent:

```bash
export PI_JEV_API_KEY="$OPENROUTER_API_KEY"
export PI_JEV_MODEL_SMALL="openrouter:qwen/qwen3.7-flash"
export PI_JEV_MODEL_NORMAL="openrouter:qwen/qwen3.7-plus"
export PI_JEV_MODEL_STRONG="openrouter:qwen/qwen3.7-max"
pi -e ./pi-jev-governor --models qwen/qwen3.7-plus,qwen/qwen3.7-flash,qwen/qwen3.7-max
```

> **Tip:** tier switching only happens within the routed model's scope.
>
> - The scope comes from `--models` (plural) or from enabledModels in pi settings; list all three tiers for free switching.
> - With only a subset, switches to out-of-scope tiers are skipped by the `scopedModels` guard: a one-time TUI warning appears, the status bar keeps showing the routed tier, and the model indicator stays unchanged.
> - To pin a single model, pass it as the only `--models` entry.
> - `--model` (singular) only picks the initial model — it creates no scope and does not block switching.

Model references use `provider:modelId` format (split on the first colon).

<details>
<summary><strong>Environment variables reference</strong></summary>

| Variable | Default | Notes |
|---|---|---|
| `PI_JEV_ENABLED` | `true` | Set `false` to disable all four decisions |
| `PI_JEV_URL` | `https://openrouter.ai/api/alpha/decisions` | JEV endpoint |
| `PI_JEV_API_KEY` | *required* | API credential |
| `PI_JEV_MODEL` | `typesafe/jev-1.13` | Decision model |
| `PI_JEV_TIMEOUT_MS` | `3000` | Total deadline per request (1–60000 ms). OpenRouter typically answers in 2–4 s; `10000` is practical |
| `PI_JEV_MODEL_SMALL` | *required* | `provider:modelId` |
| `PI_JEV_MODEL_NORMAL` | *required* | `provider:modelId` |
| `PI_JEV_MODEL_STRONG` | *required* | `provider:modelId` |
| `PI_JEV_ROUTE_CONFIDENCE` | `0.8` | Below → direct/current-model fallback |
| `PI_JEV_PERMISSION_CONFIDENCE` | `0.9` | Below → human approval or fail-closed |
| `PI_JEV_OUTCOME_CONFIDENCE` | `0.8` | Plan only advances on high-confidence finish |
| `PI_JEV_MAX_CORRECTIONS` | `2` | Task-wide budget, hard-capped at 2 |
| `PI_JEV_OUTCOME_GIT_DIFF` | `false` | Opt in to `git diff --stat`; full diff is never sent |
| `PI_JEV_PLAN_AUTO_EXECUTE` | `true` | `false` → plans require UI confirmation |
| `PI_JEV_LOG_DIR` | platform state dir | Explicit log directory override |

</details>

**Tier switching** keeps the current model when the target cannot be resolved, is outside `--models` scope, has insufficient context window, cannot accept images already in the branch, lacks provider auth, or the user manually changed models.

#### Switches & status

- `pi --no-jev` — disable plugin for this invocation
- `/jev` — show current phase, tier, correction budget, decision count, and log file
- `/jev off` / `/jev on` — session-level toggle (`on` cannot override `--no-jev` or `PI_JEV_ENABLED=false`)

**Degraded mode**: missing/invalid remote config enters `degraded` (not full bypass). Routing falls back to direct/current-model, Outcome automation stops, but the local permission gate stays active. Calls needing remote judgment ask the user when UI is available and fail-closed when it is not.

### Lifecycle

```text
user prompt
   │
   ▼
route: plan_strategy + tier
   ├─ direct ────────────────────────────────┐
   ├─ plan_only (read-only) ─────────────────┤
   └─ planning (read-only)                   │
        │ Outcome validates the plan         │
        ├─ retry/replan → revise plan        │
        ├─ finish → restore tools, execute   │
        └─ unavailable/low confidence → stop │
                                              ▼
                                     Outcome validates delivery
                                        ├─ finish → settle
                                        └─ retry/replan → correct and continue
```

- Each new `before_agent_start` begins a task and clears its approval cache. Continuations, steering, and follow-ups inherit the active route.
- State is stored as `jev-state` session entries. Resume and tree navigation restore from the active branch via `getBranch()`, including the read-only tool snapshot, correction budget, and model-routing state.
- Continuation is committed atomically at the settle boundary: state entry + `custom_message` with `continue: true`, then pi recomputes whether the final context can continue.

### Permission gate

Four-layer permission pipeline:

1. **Phase gate** — planning phases allow only built-in read tools and allowlisted read-only shell commands
2. **Deterministic rules** — block hard-deny shell patterns, allow built-in read tools, honor task approvals
3. **JEV adjudication** — clean, sanitized tool input sent to JEV
4. **Human / fail-closed** — `ask`, low confidence, sensitive input, or remote error → user prompt; no UI → block

Human choices are task-scoped: allow once · allow exact call for task · allow tool for task · block. Caches clear on next task and on session-tree navigation.

### Privacy & data disclosure

The plugin sends the **minimum evidence** needed for each decision:

| Data | Remote behavior |
|---|---|
| Task prompt | Truncated, secret literals scrubbed |
| Ordinary tool input | Sensitive keys redacted, length limited |
| Clean shell command | Sanitized then sent |
| Command with credentials | **Never sent** — local confirmation or fail-closed |
| Sensitive-file evidence | Replaced with omission marker |
| Tool-result tail | ≤ 10 entries, truncated and redacted |
| `git diff --stat` | Only when explicitly enabled; full diff never sent |

Credential detection is intentionally narrow (Authorization/Bearer headers, `KEY=value` credential contexts, private-key headers, configured secrets). Broad entropy matching is not used — hashes and git SHAs are common in legitimate commands.

<details>
<summary><strong>Decision logs</strong></summary>

Each session gets its own `decisions-<session-id>.jsonl` file. Log directory priority:

1. `PI_JEV_LOG_DIR`
2. `$XDG_STATE_HOME/pi-jev`
3. macOS: `~/Library/Application Support/pi-jev`
4. Windows: `%LOCALAPPDATA%/pi-jev`
5. Fallback: `~/.local/state/pi-jev`

Directories: mode `0700`; files: mode `0600`. Logs contain structured answers, confidence, timing, usage, effective action, and sanitized error reasons — never raw prompts, tool arguments, provider bodies, or keys.

</details>

### Security boundary

This package is **workflow control, not an OS sandbox**. It runs inside pi with the same process privileges. Use containerization or another system security boundary for untrusted or unattended execution.

### Development

```bash
npm install
npm run typecheck
npm test
```

Tests cover decision logic, extension wiring, parallel permission confirmations, branch recovery, log permissions, and a real public-API agent lifecycle using pi's faux provider.

#### Acceptance testing

An automated acceptance harness exercises the plugin end-to-end: real pi, real agent models, and a deterministic local JEV mock. Each case leaves per-case evidence and a summary `RESULTS.md`:

```bash
./scripts/run-acceptance.sh    # 23 cases (H01–H22 plus the H20b variant); requires .env.local and pi on PATH
```

Interactive TUI behavior is covered by the manual screenshot protocol in [docs/acceptance-tests.md](docs/acceptance-tests.md).

### Documentation

- [docs/design.md](docs/design.md) — v3 design specification
- [docs/acceptance-tests.md](docs/acceptance-tests.md) — acceptance test protocol
- [scripts/smoke.md](scripts/smoke.md) — manual smoke checklist

### License

MIT

---

<div align="center">

<a id="zh"></a>

## 简体中文

</div>

[pi](https://pi.dev) 编码代理的「治理器」（governor）——通过 JEV Decisions API 路由四个关键决策点，为编码代理增加智能规划、模型路由、权限控制和结果校验能力。

### 功能概览

| 决策 | pi 事件 | 结果 |
|---|---|---|
| `plan_strategy` | `before_agent_start` | `direct`、`plan_only`，或只读的 `plan_then_execute` 阶段 |
| `tier` | `before_agent_start` | `small` / `normal` / `strong` 三档，带模型兼容性守卫 |
| `permission.action` | `tool_call` | 确定性规则 → JEV 裁决 → 人工/fail-closed 兜底 |
| `outcome` | `agent_before_settle` | finish / retry / replan，任务级共享修正预算 |

- `plan_strategy` 和 `tier` 合并在一次请求中。`plan_then_execute` 任务在执行前会额外发起一次 Outcome 请求校验计划。
- 规划修订与执行纠正共享最多 **2 次**的硬上限修正预算。
- 由 pi 直接加载，**无捆绑运行时依赖，不修改 pi 本身**。

### 演示

在 pi TUI 中录制的四个任务（通过 `scripts/run.sh --models qwen/qwen3.7-plus,qwen/qwen3.7-flash,qwen/qwen3.7-max` 启动）。每条 prompt 提交后，注意底部状态栏（`jev:<phase>/<tier>`）与右下角模型指示器的变化。

**一句话知识问答 → `direct/small`：**模型从 `qwen3.7-plus` 降到 `qwen3.7-flash`。

<p align="center">
  <img src="https://github.com/qianyuxiang-369/pi-jev-governor/releases/download/demo-media/route-small-flash.gif" alt="简单问答被路由到 small 档：状态栏从 jev:ready 翻转为 jev:direct/small，模型从 qwen3.7-plus 切到 qwen3.7-flash" width="600">
</p>

**常规三步实现任务 → `direct/normal`：**从 `qwen3.7-flash` 回升到 `qwen3.7-plus`。

<p align="center">
  <img src="https://github.com/qianyuxiang-369/pi-jev-governor/releases/download/demo-media/route-normal-plus.gif" alt="三步统计工具被路由到 normal 档：状态栏翻转为 jev:direct/normal，模型切到 qwen3.7-plus" width="600">
</p>

**多方共享模块的高风险重构 → `plan_then_execute/strong`：**先在 `qwen3.7-max` 上进行只读规划，规划期间仅允许只读命令。

<p align="center">
  <img src="https://github.com/qianyuxiang-369/pi-jev-governor/releases/download/demo-media/plan-then-execute.gif" alt="高风险重构进入只读规划阶段：状态栏翻转为 jev:planning/strong，模型切到 qwen3.7-max，规划期间仅运行只读命令" width="600">
</p>

**架构设计题 → `plan_only/strong`：**交付物是分析报告，在 `qwen3.7-max` 上完成分析，不做任何实现。

<p align="center">
  <img src="https://github.com/qianyuxiang-369/pi-jev-governor/releases/download/demo-media/plan-only-strong.gif" alt="架构设计题被路由为 plan-only：状态栏翻转为 jev:plan_only/strong，模型切到 qwen3.7-max" width="600">
</p>

### 实测效果（MATH-500 基准）

**结论：成本最多省 45%，精度全部持平或更高（差异在重跑噪声带内）——Jev 的实测价值在成本分配与可忽略的开销，不在精度。** 测量方式为 opencode+jev（开 Jev）对比 opencode（不开 Jev），题集是 HuggingFaceH4/MATH-500 的 458 道文本题（42 道含图题排除）。基准在 opencode 集成上完成，使用相同的 JEV Decisions API，覆盖 pi-jev 四个决策点中的三个（模型路由 / 权限 / 结果判定）；`plan_strategy` 为 pi-jev 新增，未在基准范围内：

| 基线配置 | Jev 路由配置 | 精度变化 | 成本变化 |
|---|---|---|---|
| qwen3.8-27b | 简单题 flash / 主力 27b / 难题 max | 97.4% → 98.3% | −1.4% |
| qwen3.8-27b | 简单题 27b / 主力 flash / 难题 max | 98.0% → 99.1% | **−45%** |
| qwen3.8-flash | 简单题 flash / 主力 27b / 难题 max | 91.5% → 98.7% | +51% |
| qwen3.7-plus | 简单题 flash / 主力 plus / 难题 max | 98.3% → 98.7% | −13% |

**关键发现**：

- **精度不输**：四组对照精度全部持平或更高（强基线 +0.4～+1.1pp，在重跑噪声带内）
- **成本可降 45%**：关键是主力档用便宜模型——主力换 flash 省 45%，主力不换只省 1.4%；价差越大省得越多（3.7 系价差 ~10 倍，省 13%）
- **Jev 开销极低**：决策成本仅占 1.4–2.6%，延迟 P50 0.6-0.7s（P95 ≤1.6s），不到总延迟的 5%
- **轻量级治理**：Model Router 把约 22–23% 的题判为 easy 并分到便宜模型（该子集零精度损失）；Outcome Judge 与 Permission Gate 在纯问答任务上几乎不触发（需编码类任务验证）；本数据集上 hard 档一次都未触发
- **归因边界**：唯一统计显著的提升（flash 基线 91.5% → 98.7%）按报告消融主要来自 agent/脚手架切换而非模型路由

> 📊 完整测试报告与方法论细节见 [docs/math500-final-report-20261003.md](docs/math500-final-report-20261003.md)（原报告收录于 [opencode-jev](https://github.com/qianyuxiang-369/opencode-jev) 仓库）

### 安装

```bash
# 从 Git 安装（跟踪默认分支）
pi install git:github.com/qianyuxiang-369/pi-jev-governor

# 锁定到已发布的 tag（尚未打 tag；发布后可用）：
# pi install git:github.com/qianyuxiang-369/pi-jev-governor@<tag>

# 从本地目录安装
pi install ./pi-jev-governor
```

npm 发布尚未进行，在此之前请使用 Git 或本地安装。

不安装、直接试用本地检出：

```bash
pi -e ./pi-jev-governor
```

> **需要 pi 0.87.1+** ——0.87.1 与 1.1.0 均通过完整验收（各 54 项断言；证据分别在 0.87.1 的 [`evidence/acceptance-20261008-163809`](evidence/acceptance-20261008-163809) 与 1.1.0 的 [`evidence/acceptance-20261008-180941`](evidence/acceptance-20261008-180941)）。`@earendil-works/pi-ai` 与 `@earendil-works/pi-coding-agent` 是 peer 依赖，由 pi 提供。

### 配置

最少只需配置 JEV 凭据和每档一个 pi 模型。仓库提供 `.env.local` 模板和启动脚本：

```bash
cp .env.local.example .env.local   # 填入 key 和模型
./scripts/run.sh                   # 在任意草稿项目目录下执行
```

等价的手动方式：

```bash
export PI_JEV_API_KEY="$OPENROUTER_API_KEY"
export PI_JEV_MODEL_SMALL="openrouter:qwen/qwen3.7-flash"
export PI_JEV_MODEL_NORMAL="openrouter:qwen/qwen3.7-plus"
export PI_JEV_MODEL_STRONG="openrouter:qwen/qwen3.7-max"
pi -e ./pi-jev-governor --models qwen/qwen3.7-plus,qwen/qwen3.7-flash,qwen/qwen3.7-max
```

> **提示：** tier 切换只在路由目标模型的作用域内发生。
>
> - 作用域由 `--models`（复数）或 pi settings 的 enabledModels 定义，三档全列即可自由切换。
> - 只列部分档位时，超出作用域的切换会被 `scopedModels` 守卫跳过：TUI 弹一次性警告，状态栏仍显示路由档位，右下角模型指示器不变。
> - 想锁定单模型，把它作为 `--models` 的唯一条目。
> - `--model`（单数）只设定初始模型，不构成作用域，也不会阻止切换。

模型引用格式为 `provider:modelId`，按第一个冒号切分。

<details>
<summary><strong>环境变量参考</strong></summary>

| 环境变量 | 默认值 | 说明 |
|---|---|---|
| `PI_JEV_ENABLED` | `true` | 设为 `false` 关闭全部四个决策 |
| `PI_JEV_URL` | `https://openrouter.ai/api/alpha/decisions` | JEV 端点 |
| `PI_JEV_API_KEY` | *必填* | API 凭据 |
| `PI_JEV_MODEL` | `typesafe/jev-1.13` | 决策模型 |
| `PI_JEV_TIMEOUT_MS` | `3000` | 整次请求总超时（1–60000 ms）。OpenRouter 实测常见 2–4 s，建议设 `10000` |
| `PI_JEV_MODEL_SMALL` | *必填* | `provider:modelId` |
| `PI_JEV_MODEL_NORMAL` | *必填* | `provider:modelId` |
| `PI_JEV_MODEL_STRONG` | *必填* | `provider:modelId` |
| `PI_JEV_ROUTE_CONFIDENCE` | `0.8` | 低于该置信度回退 direct/当前模型 |
| `PI_JEV_PERMISSION_CONFIDENCE` | `0.9` | 低于该置信度转人工确认；无 UI 则阻断 |
| `PI_JEV_OUTCOME_CONFIDENCE` | `0.8` | 计划只有在明确且高置信的 finish 下才进入执行 |
| `PI_JEV_MAX_CORRECTIONS` | `2` | 任务级预算，硬上限 2 |
| `PI_JEV_OUTCOME_GIT_DIFF` | `false` | 显式开启才发送 `git diff --stat`；从不发送 diff 正文 |
| `PI_JEV_PLAN_AUTO_EXECUTE` | `true` | 设为 `false` 时，计划通过后需 UI 确认才执行 |
| `PI_JEV_LOG_DIR` | 平台状态目录 | 显式指定日志目录 |

</details>

**tier 切换**在以下情况保留当前模型：目标模型无法解析、不在 `--models` 作用域内、上下文窗口不足、无法接受分支中已有的图片、provider 未配置鉴权，或用户手动切换过模型。

#### 开关与状态

- `pi --no-jev` — 对本次调用禁用插件
- `/jev` — 显示当前阶段、tier、修正预算、决策计数和日志文件
- `/jev off` / `/jev on` — 会话级切换（`on` 不能覆盖 `--no-jev` 或 `PI_JEV_ENABLED=false`）

**降级模式**：远端配置缺失或无效时进入 `degraded` 模式（非完全旁路）。路由使用 direct/当前模型兜底，Outcome 自动化停止，但本地权限门保持生效。需要远端裁决的调用在有 UI 时询问用户，无 UI 时 fail-closed 阻断。

### 生命周期

```text
用户 prompt
   │
   ▼
路由：plan_strategy + tier
   ├─ direct ────────────────────────────────┐
   ├─ plan_only（只读）──────────────────────┤
   └─ planning（只读）                        │
        │ Outcome 校验计划                    │
        ├─ retry/replan → 修订规划            │
        ├─ finish → 恢复工具，开始执行         │
        └─ 不可用/低置信 → 停止                │
                                              ▼
                                     Outcome 校验交付物
                                        ├─ finish → 结束
                                        └─ retry/replan → 纠正并续跑
```

- 每次新的 `before_agent_start` 开启一个任务并清空其批准缓存。续跑、steering 和追问继承活动路由，不会重新路由。
- 状态以 `jev-state` 会话条目存储。会话恢复与分支导航通过 `getBranch()` 从活动分支还原，包括只读工具快照、修正预算和模型路由状态。
- 续跑在 settle 边界原子提交：状态条目与 `custom_message` 以 `continue: true` 一起返回，随后由 pi 重算最终上下文能否续跑。

### 权限门

四层权限管线：

1. **阶段门** — 规划阶段仅允许内置读工具和白名单内的只读 shell 命令
2. **确定性规则** — 拦截高危 shell 模式、放行内置读工具、遵循任务级批准
3. **JEV 裁决** — 干净且已脱敏的工具输入才发送给 JEV
4. **人工 / fail-closed** — `ask`、低置信、敏感输入或远端错误 → 转给用户；无 UI 则阻断

人工选择是任务级的：仅允许一次 · 允许本任务此调用 · 允许本任务此工具 · 阻止。缓存在下一个任务和会话树导航时清空。

### 隐私与数据披露

插件为每个决策发送**最少量的证据**：

| 数据 | 远端行为 |
|---|---|
| 任务 prompt | 截断并擦除 secret 字面量 |
| 普通工具输入 | 敏感键脱敏，长度受限 |
| 干净 shell 命令 | 脱敏后发送 |
| 含凭据的命令 | **从不发送** — 本地确认或 fail-closed |
| 敏感文件证据 | 替换为省略标记 |
| 工具结果尾部 | ≤ 10 条，截断并脱敏 |
| `git diff --stat` | 仅显式开启时发送；从不发送 diff 正文 |

凭据检测刻意保持窄范围（Authorization/Bearer 头、`KEY=value` 凭据上下文、私钥头、配置 secret 字面量）。不使用广义高熵匹配——哈希常量和 git SHA 在合法命令中很常见。

<details>
<summary><strong>决策日志</strong></summary>

每个会话独立文件 `decisions-<session-id>.jsonl`。日志目录优先级：

1. `PI_JEV_LOG_DIR`
2. `$XDG_STATE_HOME/pi-jev`
3. macOS：`~/Library/Application Support/pi-jev`
4. Windows：`%LOCALAPPDATA%/pi-jev`
5. 兜底：`~/.local/state/pi-jev`

目录权限 `0700`，文件权限 `0600`。日志包含结构化答案、置信度、耗时、用量、实际生效动作和脱敏错误原因——不包含原始 prompt、工具参数、provider 响应体或密钥。

</details>

### 安全边界

本包是**工作流控制，不是操作系统级沙箱**。它与 pi 运行在同一进程、拥有相同权限。不可信或无人值守的执行请使用容器化或其他系统安全边界。

### 开发

```bash
npm install
npm run typecheck
npm test
```

测试覆盖纯决策逻辑、扩展接线、并发权限确认、分支恢复、日志权限，以及基于 pi 公开 API 和 faux provider 的真实 agent 生命周期测试。

#### 验收测试

自动化验收 harness 做端到端验证：真实的 pi、真实的 agent 模型，JEV 决策指向本地确定性 mock。每个用例留档四份证据并生成 `RESULTS.md` 汇总：

```bash
./scripts/run-acceptance.sh    # 23 个用例（H01–H22 及 H20b 变体）；需要 .env.local 与 PATH 中的 pi
```

交互 TUI 行为由 [docs/acceptance-tests.md](docs/acceptance-tests.md) 中的人工截图协议覆盖。

### 文档

- [docs/design.md](docs/design.md) — v3 设计规范
- [docs/acceptance-tests.md](docs/acceptance-tests.md) — 验收测试协议
- [scripts/smoke.md](scripts/smoke.md) — 人工冒烟清单

### 许可证

MIT
