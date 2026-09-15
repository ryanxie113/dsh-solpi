# Discussion 发帖草稿（deepseek-harness GitHub Discussions）

> 发布位置：https://github.com/deepseek-ai/deepseek-harness/discussions
> 建议分类：**Show and tell**（若无此类则选 Q&A 转分享性质的最接近分类）
> 关联仓库：https://github.com/ryanxie113/dsh-solpi （已打 `dsh-plugin` topic）

---

## 英文正文（可直接粘贴）

### Title

**solpi-dsh: four efficiency mechanisms for long task sessions (an out-of-tree `dsh-plugin`)**

### Body

Hi all 👋 We've been running long multi-hour coding sessions on dsh and kept hitting
the same four frictions: edits needed a manual follow-up command, planning phases got
spilled previews instead of full code, ten-thousand-line test logs drowned the
context, and the session only ever grew.

**[solpi-dsh](https://github.com/ryanxie113/dsh-solpi)** is our answer — a single npm
bundle that ships four independent mechanisms:

| Mechanism | What it does |
|---|---|
| **Action Fusion** | edit/write + a follow-up shell command in *one* tool call (`thenRun`), result marked `[then_run:succeeded/failed/skipped]` |
| **ObservationPack** | exempt large tool outputs from spill truncation while the session is in plan mode |
| **Evidence-Preserving Reducer** | collapse huge diagnostic output into a ~1KB receipt that preserves quotable lines verbatim; full text stays on disk (`$DSH_HOME/sol-pi/epr/`) |
| **Online Context Compact** | token-economics gate decides *when* compacting pays for itself (writeTokens vs archiveTokens vs breakeven), then reuses compaction-basic's region machinery |

Everything is off by default, each mechanism can be toggled independently, and they
compose naturally: spill-policy trims big outputs first, EPR collapses diagnostics,
and OCC's economic gate works on what's left — the session skeleton, not the raw flood.

**It's measurable.** A durable event log lands at `$DSH_HOME/sol-pi/telemetry/events.jsonl`
(fail-open, size-rotated). In our live-fire run — a red→green node:test fix loop —
14 events closed the loop across three ledgers: telemetry `epoch=2` ↔ OCC state file
`epoch=2/requestCount=6` ↔ six gate checks. One concrete sample: a 5255-byte failing
test log reduced to a 1480-byte receipt carrying 5 verbatim quotes; the model cited
the fatal line correctly afterwards.

**Build notes that might help other plugin authors** (things we learned the hard way):

1. Plugins are transpiled by the entry loader in **CJS output format** — top-level
   `await` in a plugin module fails the boot ("Top-level await is currently not
   supported"). Keep module init synchronous.
2. Bundle packages must watch their `files` whitelist: compaction-basic ships only
   `lib/`, so its `"./src/*"` export map entry is unreachable from npm installs.
   If you reach into another package's internals, ask upstream to make it public API.
3. `dsh plugin add <dir>` ≠ bare `pnpm add <dir>` — only the former reconciles
   `dsh.profile.bundles`. And it operates under `$DSH_HOME`, which may not be the
   directory you're looking at.
4. The `SOLPI_DSH_ROOT`-style escape hatch (env var → walk-up probe → fail-fast) has
   worked well as a general pattern for out-of-tree plugins that need to anchor
   against the running installation.

**Three upstream proposals** came out of this work ([drafts here](https://github.com/ryanxie113/dsh-solpi/blob/main/docs/upstream-proposals.md)):

1. Expose cache read/write token metering through `tokenMeter.measure` (cache
   economics gates are currently config assumptions, not measurements);
2. Tag compaction boundaries with a `purpose` field so third-party and built-in
   compactions are distinguishable in forensics;
3. Make region-selection logic part of a package's public surface for safe reuse.

Known limits are documented honestly in the README (single model/provider validated,
dual-session concurrency tested only lightly). Feedback and issue reports welcome —
especially if you try it against different providers or larger windows.

---

## 中文速览（自校对用，不发帖）

- 开头两句共情痛点（编辑断档/规划看不全/日志洪峰/上下文只涨）→ 引出四机制表
- 强调「默认全关、独立开关、天然分层」的设计观
- 实测段落是说服力核心：三方账目闭合 + 5255B→1480B 回执实例
- 「build notes」四条是对社区的差异化贡献（别的 Show and tell 帖不会讲这些）
- 三提案链接作为回馈姿态，降低「白嫖框架」观感
- 结尾诚实边界 + 开放反馈

## 发帖后动作

1. 把帖子 URL 回填到本仓库 README（Community 一节）与 `docs/plugin-packaging-notes.md`
2. 监控回复；若维护者回应提案，按其反馈修订 docs/upstream-proposals.md 后提 issue

---

## 追评草稿 #2（benchmark 数据 + 容错修复轮，2026-09-15）

> 发布位置：Discussion #6577 原帖下的评论（英文）
> 触发条件：两前置（thenRun 强化、EPR/OCC 层叠疑云）均已解决 ✅

### Comment body (EN, paste-ready)

**Follow-up: benchmark results and robustness fixes after live-fire testing**

We ran a four-task benchmark suite against the plugin in both arms
(vanilla dsh vs dsh + solpi-dsh) on GLM Flash via a local gateway — tasks:
a red→green diagnosis loop, a chained edit session, a 38KB document recall Q&A,
and a 12-module/36-case long-haul session. Full data & methodology:
[docs/benchmarks.md](https://github.com/ryanxie113/dsh-solpi/blob/main/docs/benchmarks.md).

Three findings worth sharing, because they generalize beyond our plugin:

1. **Compaction economics need to charge the summarizer.** Our first gate design
   compared archived tokens vs write tokens but ignored the summarizer's own
   execution cost. On short sessions this produced "compaction storms": the gate
   kept approving marginal compactions whose cost exceeded their savings.
   Fixing the break-even formula (adding `(archiveTokens + memoTokens) × summarizerCostScale`)
   cut one benchmark arm from 277s → 116s with zero behavioral difference —
   same task quality, strictly less spent.
2. **Models claim compliance; telemetry disagrees.** Our then-run fusion was
   silently unused by the model for a whole run while stdout *claimed* it was used.
   The fix that worked was not prose in the tool description but a runtime coach:
   a per-call nudge appended when the model skips `then_run`. Error-shaped feedback
   beats description text. After the fix: real fused chains verified in the event
   stream, not just in stdout.
3. **Small-model output blowouts are systemic.** Both our EPR reducer calls and
   OCC summarizer calls occasionally ramble past their token cap on GLM Flash,
   killing receipts/checkpoints. Two cheap mitigations now shipped: a tightened
   retry after a max-tokens finish, and a circuit breaker that stops re-approving
   compaction after consecutive summarizer failures instead of burning retries.

Honest limits: single-provider validation; benefits are bounded by context-window
economics — with a large free window (262k) the compact gate mostly stays shut
by design, and the value case is constrained windows or input-token-billed APIs.

The post-fix numbers vs pre-fix baselines: T1 −58%, T2 ≈−48%, T3 −33%, and the
long-haul task −80% (1168s → 230s, all 36 cases still green). Worth being honest
about that last one: most of it came from the system *learning to stop intervening* —
the economic gate rejected marginal compactions, and after two summarizer blowouts
the circuit breaker blocked the remaining 40 gate evaluations instead of burning
retries. On a large free context window, doing nothing was the fastest policy,
and the plugin now discovers that on its own. As always, raw data over vibes —
everything is in the repo.
