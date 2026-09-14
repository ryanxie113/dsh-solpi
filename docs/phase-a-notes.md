# Phase A 笔记：solpi-ext(pi) ↔ deepseek-harness(dsh) API 对照

> 规则：每一条映射必须落到两个 checkout 里的具体文件路径作为证据，不接受印象式结论。
> 参考坐标：pi 侧 `~/tools/solpi-ext/src/sol-pi/extensions/*`（锁定 `74f6f97b4577e8160dcfa7f26e44d32863b99c2c`）；dsh 侧 `~/tools/deepseek-harness/packages/*`、`docs/capability-seams.md`（锁定 `c291e7961a515f6d7af9304e7fd1d257929aef26`）。

## 已知线索 → 验证结论（2026-09-11，全部源码核对）

| # | pi 侧（已读源码确认） | dsh 侧 seam | 验证状态 |
|---|---|---|---|
| Q1 工具注册与替换 | `extension.registerTool()` 替换 edit/write，参数含可选 then_run | 插件经 `ctx.tools.register(defineTool(...))` 注册；同名替换受约束（见下） | ✅ 已验证 |
| Q2 结果拦截 | OP 用 provider-context projection handler 改写进入上下文的观察 | 三层可用：`tools/post-execute` 瀑布（即时替换）、surface 替换事件（持久替换）、`ctx.spillStore` 归档 | ✅ 已验证 |
| Q3 嵌套模型调用 | EPR 经 modelRegistry 解析 provider/model | `ctx.llm.stream(GenerateOptions)` 异步迭代器；`purpose: 'compaction'\|'session-title'` 标注辅助调用 | ✅ 已验证 |
| Q4 压缩控制 | OCC 用隐藏 triggerTurn 消息模拟新回合（绕行方案） | `ctx.compaction` 是完整可替 backend（继承 `CompactionEngine`），compaction-basic 即参考实现 | ✅ 已验证 |
| Q5 会话目录存储 | 归档落在 session 目录下 `sol-pi/<session-id>/` | 会话日志目录约定存在但**不作为公共查询暴露**；dsh 惯例 = 插件自持 config root（参照 spill-local） | ✅ 已验证 |
| Q6 外部插件装载 | pi 用 `pi install <path>` 注册用户级扩展 | 无 `dsh plugin install` CLI；本地路径装载 = cordis.yml/patch 的 `- insert: name:<绝对路径>` 或 profile bundles | ✅ 已验证 |

## Q1–Q6 详细结论（附两侧路径证据）

### Q1 工具注册与替换 — 结论：可行，但"替换内置 edit/write"有前置条件

- dsh 工具注册入口：`packages/core/tools/src/index.ts` 的 `register(definition)`（`~L1022`）——插件在 `apply(ctx)` 中调用 `ctx.tools.register(defineTool({...}))`，schema 用 `@deepseek-ai/schemastery`（z），必须带 `output: { schema, render }`。最小样例：`docs/cookbook/adding-a-tool.md` + 生产级三包样例 `packages/shell/tool-bash`。
- 内置 read/write/edit **不是特权工具**，由普通插件 `packages/fs/tool-fs/src/index.ts`（`apply()` 调 `applyReadTool/applyWriteTool/applyEditTool`）注册，bash 由 `packages/shell/tool-bash*` 注册。
- 同名约束：`ToolLayer.tools = new NamedEntries(...)` 在全局层重复注册同名即抛错（"tool "x" is already registered"，`core/tools/src/index.ts` ~L720）；agent 作用域（`agent.ctx`）注册可 shadow 全局；`run_code` 名字保留不可注册/不可 shadow（~L1045）。
- 对 AF 的含义：要让 `edit`/`write` 带 `then_run`，需 (a) 不挂载 stock tool-fs、由 solpi 变体包注册同名工具（组合层面排除），或 (b) agent 作用域 shadow。方案 (a) 更符合 "Plugins, not loop changes"。
- AF 还需要串行队列 + bash 复用：pi 侧用自有 per-path 队列（`extensions/action-fusion/file-queue.ts`）+ `createBashToolDefinition().execute()`；dsh 侧可直接 import stock `tool-bash` 的定义或走 `tools/execute` 依赖注入。

### Q2 结果拦截 — 结论：完全可行，dsh 给了比 pi 更规范的机制

三条候选路径（spec 采用 ①+③ 组合模拟 OP）：

1. **`tools/post-execute` 瀑布**：`core/tools/src/index.ts` Events 声明 `'tools/post-execute'(exec, result, next) => Promise<PostToolDecision>`——**可以替换 content**（模型可见副本），也可替换 value（程序结果）。现成范例：spill-policy 以此把超限纯文本结果换成 head/tail 预览 + 定位器（`packages/spill/spill-policy/README.md`："A `tools/post-execute` waterfall listener (registered with `prepend`, delegating via `next()`) bounds the model-facing result"；跳过 `read` 防止 read→spill→read 循环）。
2. **Surface 持久替换**：`packages/core/session/src/surface.ts` —— surface 是 log 之上的模型可见视图，替换 op（shadow 区间）本身作为事件落日志（`SurfaceOp`/`sourceEventSeqs`），"The append-only log remains the source of truth"。范例：compaction-tool-result-pruner 把超限 tool/result 换成 head+marker+tail 的新 `tool/result` 事件并引用原事件（`packages/compaction/compaction-tool-result-pruner/README.md`："swaps each over-budget tool result for one newly appended `tool/result` that replaces the original event and cites it through `sourceEventSeqs`，紧前一个 `compaction/prune` 计价事件"）。
3. **归档后端**：`ctx.spillStore.saveText(SaveTextSpill) -> SpillRef{locator, bytes, retrievalHint}`（`packages/spill/spill/src/types.ts`；owner 带 sessionId；local 实现 `packages/spill/spill-local`，文件落在 `<root>/session-<hash>/…` 0700 权限）。

与 pi OP 的语义差异表：

| 维度 | pi OP | dsh 对应 |
|---|---|---|
| 改写时机 | `pi.on("context")` 投影期（每请求重算） | 结果落地时 post-execute 一次性替换（或后续 surface 替换） |
| FULL_SENDS=2 宽限 | 前 2 个请求发原文 | dsh 无内建等价物；需插件在 `agent/pre-step` 计数请求后补 surface 替换，或放弃宽限直接首请求即预览 |
| 回读 | 注册 `obs_recall` 工具（16KB/400 行分页） | 复用 spill 定位器提示（read offset/limit/grep），无需新工具；或仍可注册 obs_recall 同名工具 |
| 会话历史完整性 | history 存储不动，投影改写 | 日志追加不改写；可见性变更以 surfaceOp 事件留痕（满足 Model-visible ⟺ logged） |
| EPR 回执豁免 | OP 跳过含 `sol_pi_evidence_receipt_v1` 前缀的结果 | 插件自查 content 前缀即可，无框架耦合 |

### Q3 嵌套模型调用 — 结论：一等公民，签名明确

- 服务：`ctx.llm.stream(options: GenerateOptions): AsyncIterable<StreamChunk>`（`packages/llm/llm/src/index.ts` ~L183/L191；types `GenerateOptions` 在同文件 ~L225 起）。
- 关键字段：`provider, model, messages, system?, tools?, temperature?, maxTokens?, stop?, signal?, sessionId?, purpose?`；`purpose?: 'compaction' | 'session-title'` 专为辅助调用标注（adapters 可映射为隐藏传输元数据）。
- 非循环调用的现成先例：compaction-basic 的 `summarizeWithLlm()` 组装 messages 后 `for await (const chunk of ctx.llm.stream(options)) assembler.push(chunk)`（`packages/compaction/compaction-basic/src/summarizer.ts` ~L158 附近，`source: { kind: 'plugin', plugin: 'dsh-compaction-basic' }` 标注消息来源）；session-title 同样 inject ['llm','sessions'] 直接消费。
- 与 pi 差异：pi 经 `context.modelRegistry.complete(model, context, options)`（兼容回退 `getApiKeyAndHeaders` + compat complete，见 `extensions/evidence-preserving-reducer/provider.ts`）；dsh 直接按 route 名（provider+model 字符串）流式调用，鉴权在 adapter 层内部解决，插件无需接触 API key —— 符合"dsh 凭证不进插件"的协议要求。
- 注意：`purpose` 是闭合联合类型，EPR 若想新增专用值需上游扩展（Phase B 探针验证未传 purpose 的普通调用是否影响 replay/cursor 分离）。

### Q4 压缩控制 — 结论：比 pi 规范得多，是完整 backend seam

- 服务声明：`packages/compaction/compaction/src/index.ts` `abstract class CompactionEngine extends Service { super(ctx, 'compaction') }`，两个抽象方法：
  - `compactIfNeeded(agent, trigger: 'pressure'|'context-overflow', signal): Promise<CompactionResult|null>`
  - `compact(agent, ...)`（显式手动压缩，idle-only）；
  每个 context 一个实现（"one implementation per context as `ctx.compaction`"）→ 插件可整替 compaction-basic。
- 触发点参考实现：compaction-basic 挂 `ctx.on('agent/pre-step')` 做 between-step 压力检查、挂 `agent/request-error` 做 CONTEXT_WINDOW_EXCEEDED_CODE 溢出恢复（`packages/compaction/compaction-basic/src/index.ts` ~L146–200）。
- OCC 移植路径：自定义 CompactionEngine 子类，把 OCC economics（remainingRequests/breakeven/cache-debt 数学，pi 侧 `extensions/online-context-compact/economics.ts`）搬进 `compactIfNeeded`；plan 边界检测改为监听自家 plan 工具调用。**不再需要 pi 的 abort+triggerTurn 绕行**：决策发生在 pre-step，压缩同步完成后 loop 自然继续；pi 侧 `turn_end` 判定 + `context.abort()` + `agent_settled` + `sendMessage(triggerTurn)` 四步舞在 dsh 无对应必要。
- 配置写法：cordis.yml 条目 config 字段（如 `thresholdRatio/retainRatio/modelPolicies[]`，见 compaction-basic README 最小配置节）；OCC 参数映射为自研 backend 的 Config schema。
- 日志词汇：`compaction/start|summary|end|prune` 事件（`packages/compaction/compaction/src/types.ts` Events 块）已内建审计轨迹，OCC journal 直接复用。
- plan 工具：dsh 的 `packages/plan/plan-mode` 是用户审批门控（/plan 命令），**不是** OCC 的进度计划工具；update_plan 需由 solpi 插件自行注册（`ctx.tools.register`，Q1 路径），进度状态存自身 root（Q5）或 session 附件事件。

### Q5 会话目录存储 — 结论：无公共 per-session 目录查询；采用插件自持 root

- 会话物理布局（jsonl backend）：`<root>/<projectKey(cwd)>/<encodeSegment(id)>/<generation>.jsonl(.zst)`；注释明说 sessionDir 是"The directory owned by one session and available for future session-local artifacts"（`packages/session/session-persistence-jsonl/src/format.ts` L253–278 `projectDir()/sessionDir()/generationLogPath()`）。默认根 `dshHomePath('sessions')` 即 `$DSH_HOME/sessions`（样例 `snapshots/sdk/text-turn/cordis.yml` L16–19；home 解析 `packages/util/home-paths/src/index.ts`：`DSH_HOME` env > `~/.dsh`）。
- 但公共契约刻意不暴露目录给消费者：`SessionLocation.path` 仅用于拒载诊断（"it is not a consumer-facing query — log access goes through a session handle's `read`"，`packages/session/session-persistence/src/errors.ts` L85–93）；服务接口 `SessionPersistence` 只有 create/open/flush/stat/list（`.../session-persistence/src/index.ts` L135 起）。
- dsh 自己对插件级会话产物的惯例做法：spill-local 用 plugin Config.root（默认 `mkdtemp(tmpdir/dsh-spill-*)` 私有根，0700），按 `sessionDir(root, sessionId)` 编码分桶（`packages/spill/spill-local/src/store.ts` L36–78；Config 在 `src/index.ts` L31–67）。
- solpi 移植决定：OP/EPR 归档 root 用自研 Config（默认建议 `$DSH_HOME/sol-pi/`，经 `resolveDshHome()` from `@deepseek-ai/dsh-home-paths`），内部再按 `sha256(sessionId).slice(0,16)` 或 encodeSegment(sessionId) 分桶 + 内容寻址 objects，保持与 pi 版相同的 runId 语义。**不**尝试解析 session jsonl 所在目录（避免耦合 backend 内部布局）。

### Q6 外部插件装载 — 结论：无 CLI 安装命令；本地路径装载 = patch 文件 insert

- 插件本体约定：TS 模块导出 `export const name` + `export function apply(ctx: Context)`（`docs/user/develop/basic/index.md`"Your first plugin"）。
- 本地路径装载两条正路（均基于 cordis 组合文件，非安装命令）：
  1. **launcher overlay**：`pnpm dsh web --patch ./file.yml`，patch 里 `- insert: [{ id, name: '<绝对路径>' }]`（同上教程；"The plugin path must be absolute"）。
  2. **profile 用户层**：`$DSH_HOME/profiles/<name>/cordis.patch.yml` + bundle npm 包列表写在 profile manifest `dsh.profile.bundles`；模块双锚点解析：先 dsh 安装树、后 profile `node_modules`（`packages/boot/app-boot/src/profile.ts` 模块头注释；`PROFILES_DIR='profiles'`、`PROFILE_PATCH_FILENAME='cordis.patch.yml'`）。
- 全仓无 `plugin install` 子命令（检索 `packages/host`、CLI 相关包仅命中无关项）。
- solpi 移植路径：开发期用 `--patch ./cordis.dev.yml` 指向本仓库 `packages/solpi-dsh/src/*.ts`；长期分发形态二选一：(a) 发布 npm 包进 profile bundles；(b) 直接维护用户 profile patch 文件指向 checkout 绝对路径。Phase A 记录为"支持，但机制是组合文件而非 CLI"。

## Phase B 探针设计（草案，随 Q 结论更新）

唯一目标：验证 Q2 三层机制的实操手感（post-execute 内容替换 + spillStore 归档 + surface 替换记录）。
最小实验 = hello-plugin 三个动作：
1. `tools/post-execute` prepend 监听器：对某工具输出追加 `[solpi-probe]` 标记文本（next() 后包装 PostToolDecision）。
2. 同时 `ctx.spillStore.saveText` 存原文，观察 locator 出现在替换文本中。
3. （可选）落一条 surface 替换，验证 resume/replay 后标记仍在且日志可重建。

通过判据：标记稳定出现在模型可见上下文中；原始结果字节仍在日志（Model-visible ⟺ logged 保持）；不改坏程序返回值。
次级判据：`--patch` 本地装载成功、`ctx.llm.stream` 一次一次性调用可达（顺带覆盖 Q3）。

## 遗留风险登记

- dsh API 快速漂移（developer preview）：本文所有行号为 commit `c291e79` 时点值，升级需重跑对照。
- `purpose` 闭合联合 & surface 替换 API 的具体导出面（哪些函数从 `@deepseek-ai/dsh-session` 公开导出）未逐一核对导出清单，Phase B 写探针时确认。
- FULL_SENDS 宽限若要保真移植，需要在 pre-step 钩子自行计数请求轮次——复杂度高于 pi 投影法，Phase C 设计评审时决定取舍（候选：接受"首请求即预览"简化）。

## Phase C 追记（2026-09-11）
Phase C（AF+OP 移植实作与验收）已完成，结论与全部证据不落本文件——见 `docs/plans/dsh-solpi-spec.md` §9 实作实录。对本文档读者的三个直接影响：
1. §Q6 装载结论追加惯用式：out-of-tree TS 入口用 async `apply()` + `await import(pathToFileURL(abs))`（require 解析 ESM-TS 不可行、top-level await 过不了 esbuild transform）。
2. §Q5/Q3 的配置传递修订：insert entry 支持 `config` 直传（cordis `EntryOptions.config → fiber.update`），无 zod schema 时插件内部 normalize——OP 阈值即走此路径。
3. OP 不再按原计划重造：dsh 原生 spill-policy 与 pi ObservationPack 同构，Phase C 采用组合层薄封装（决策 B）；P8（ctx.shell 承载 then_run）实证可行，AF 即构建其上。

## Phase D 追记（2026-09-11）
EPR 已实装并验收（详见 spec §10）。对本文档读者的直接影响：
1. §B-EPR-1/P5 关闭：dsh bash 的全量输出经 `value.stdout.spillPath`（CollectedOutput）+ render 内嵌 "full output:" 标记获取，与 pi 的 untruncated-file 契约同构。
2. llm 一次调用无需扩展 purpose 联合——GenerateOptions 有独立 `system` 字段；finishReason 需剥 `{"kind":…}` 信封。
3. Out-of-tree Config 定案：导出 schemastery Config 即被 loader 解析（缺省物化）；无 `.optional()`，可选字段裸声明。

## Phase E 追记（2026-09-11）
OCC 已实装并验收，四机制全部完成（详见 spec §11）。直接影响本文读者的三点：
1. §Q4 压缩缝的最终形态确认：子类继承 BasicCompactionEngine、只覆写压力分支门控，机械全继承——"SoL-Pi 决定何时压，dsh 决定怎么压"。
2. dsh 无原生 update_plan 步骤工具（plan-mode 是另一回事）；OCC 边界源需随插件自带 `solpi_update_plan`。
3. 类形态插件的服务依赖声明必须用 `static inject`（模块级 export inject 对类形态无效）。
