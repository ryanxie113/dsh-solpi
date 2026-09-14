# dsh-solpi 移植规范：solpi-ext 四机制 → deepseek-harness 接缝

> 状态：Phase A 产物 · 接口契约级（签名、调用方式、与 pi 侧差异）
> 坐标锁定：solpi-ext @ `74f6f97b4577e8160dcfa7f26e44d32863b99c2c`；deepseek-harness @ `c291e7961a515f6d7af9304e7fd1d257929aef26`
> 证据规则：每条映射落两侧具体文件路径；dsh 行号为 commit `c291e79` 时点值，升级须重跑对照。
> 配套问答详证：`docs/phase-a-notes.md`（Q1–Q6 逐项）。

---

## 0. 总览

| 机制 | pi 侧扩展点（solpi-ext） | dsh 侧接缝 | 移植形态 |
|---|---|---|---|
| AF 动作融合 | `pi.registerTool()` 替换 edit/write + `then_run` 参数 | `ctx.tools.register(defineTool(...))`，组合层排除 stock tool-fs | 新工具包注册同名变体 |
| OP 观察包 | `pi.on("context")` 投影重写 + `obs_recall` 工具 | `tools/post-execute` 内容替换 + `ctx.spillStore.saveText` 归档（+ 可选 surface 替换补发） | post-execute prepend 监听器 |
| EPR 证据还原 | `pi.on("tool_result")` 重写 + 嵌套模型调用 + 回执替换 | 同 Q2 监听器链上做候选检测/归档，嵌套调用走 `ctx.llm.stream(GenerateOptions)` | 与 OP 合并为一个监听器，先 EPR 后 OP 豁免排序 |
| OCC 在线上下文压缩 | 判定→abort→compact→triggerTurn 绕行 | 继承 `CompactionEngine` 整替 backend，决策点在 `agent/pre-step` | 自研 CompactionEngine 子类 |

机制间关系保持 pi 版拓扑：EPR 先于 OP 处理同一结果（OP 跳过带 EPR 回执前缀的内容）；OCC 的 plan 边界由自注册 update_plan 工具供给。

**全局协议约束回填**（来源两仓库 AGENTS.md / docs/capability-seams.md）：
- Model-visible ⟺ logged：OP/EPR 对模型可见内容的任何改动必须以「事件落地」方式留痕（post-execute 改写的最终结果本身会被会话日志记录），不得仅做请求期瞬态改写。
- Plugins, not loop changes：四机制全部以插件/组合文件表达，不改 `packages/core/agent-loop`。
- 瀑布监听器必须调 `next()`（`tools/post-execute` 等）；spill-policy 先例即 `prepend` 注册 + 委托 next()。
- 插件不硬编码调节参数：全部走 cordis.yml config 字段（dsh 现有惯例：compaction-basic 的 Config schema 即模板）。

---

## 1. AF 动作融合

### 1.1 pi 侧契约回顾
源：`src/sol-pi/extensions/action-fusion/{index.ts,then-run.ts,file-queue.ts}`
- `createEditToolDefinition/createWriteToolDefinition` 增加 `then_run?: string` 参数；execute 完成编辑后若 `then_run` 非空：按规范路径查 per-path 串行队列（`withFusedFileQueue`），无队列则跳过（标记 `[then_run:skipped]`）；否则执行 bash，融合输出 `[then_run:succeeded|failed]\n<stdout/stderr>`。
- 干扰防护：命令前后 sha256 快照比对 + `setImmediate` yield（防同步篡改检测盲区）。

### 1.2 dsh 侧接口契约
- 工具定义工厂：`defineTool({ name, description, parameters, output: { schema, render }, execute })`，schema 用 `@deepseek-ai/schemastery`。证据：`packages/core/tools/src/index.ts`（register ~L1022）、cookbook `docs/cookbook/adding-a-tool.md`、生产样例 `packages/shell/tool-bash/src/index.ts`。
- 名称约束：ToolLayer 全局层同名重复抛错（"tool "x" is already registered"，~L720）；agent 作用域可 shadow 全局；`run_code` 保留名不可用（~L1045）。证据同文件。
- stock edit/write 由普通插件提供：`packages/fs/tool-fs/src/index.ts` `applyReadTool/applyWriteTool/applyEditTool` → **可组合排除**：profile cordis.yml 不挂载（或 disable）tool-fs 行，改挂 solpi 变体包即可让 `edit/write` 名字落到我们的实现。
- then_run 执行体（bash）：stock `packages/shell/tool-bash/src/index.ts` 仅导出 `apply(ctx, config)`（L189），**没有**独立 definition 工厂供 import——pi 版「import createBashToolDefinition 后手动 .execute()」的复用法在 dsh 不成立。

### 1.3 契约级移植设计
```yaml
# profile 组合（示意）：排除 stock，挂 solpi 变体
plugins:
  # - name: '@deepseek-ai/dsh-tool-fs'   ← 不挂载 / disabled: true
  - id: solpi-tool-fusion
    name: '@sol-pi/dsh-tool-fusion'
```
```
包内：
  createFusedEditTool(deps: { queueRegistry, runCommand }, base: StockLikeImpl)
    -> ToolDefinition            // parameters = 原 edit params + { then_run?: string }
  execute(args):
    1. 原 edit 逻辑（拷贝 tool-fs 编辑算法或经内部共享函数）
    2. 若 then_run: fileQueue(path).add(() => runCommand(then_run))  // 串行，跨并发结果复用
    3. sha256 前后快照 + setImmediate yield（逐字节照搬 pi 版干扰防护语义）
    4. 输出追加 "[then_run:succeeded|failed]\n<cmd output>"，失败不吞编辑成功事实
  runCommand: 进程内 spawn（node:child_process）自持实现；Phase B 核对 ctx.shell 服务面，
              若其 API 允许直接 spawn 则改走 shell 服务以共享 env 快照/shellEnv 注入语义
```
- 参数校验、output.render 必须齐备（dsh 强制 output.schema/render，pi 无此强制——差异点，render 返回简洁文本预览）。
- 多文件并发写同一路径的串行化由我们自带 file-queue 保证（pi 版语义原样移植）。

### 1.4 与 pi 差异表
| 维度 | pi | dsh |
|---|---|---|
| 注册入口 | pi.registerTool | ctx.tools.register；需组合层配合排除 tool-fs |
| bash 复用 | import 定义 + .execute() | 无公共定义工厂：spawn 自持或待验 ctx.shell |
| output 契约 | 仅 text | 强制 output.schema + render |
| shadow 通道 | 单层 register 替换 | agent 作用域可 shadow 全局（备用路径，非首选） |

---

## 2. OP 观察包

### 2.1 pi 侧契约回顾
源：`extensions/observation-pack/{index.ts,observation.ts}`
- 存储：`<sessionDir>/sol-pi/<sessionId>/objects/<hash>.txt` 内容寻址 + ledger.jsonl。
- 投影：`pi.on("context")` 逐请求重算——>10KB 结果前 FULL_SENDS=2 个请求发原文，之后换占位符（fail-open 出错放行原文）；含 EPR 回执前缀的结果跳过。
- 回读：注册 `obs_recall` 工具（16KB/页、400 行上限分页）。

### 2.2 dsh 侧接口契约
三个接缝组合，全部有现成范例：

(a) **即时替换与归档 —— post-execute + spillStore**
```ts
// packages/core/tools/src/index.ts L590–593（原文）
export type PostToolDecision =
  | { kind: 'accept'; content?: ContentBlock[]; value?: never; additionalContexts?: UserMessage[] }
  | { kind: 'accept'; value: JsonValue; content?: never; additionalContexts?: UserMessage[] }
  | { kind: 'block'; feedback: ContentBlock[]; additionalContexts?: UserMessage[] }
// Events: 'tools/post-execute'(exec: ToolExecution, result: Readonly<ToolExecutionResult>,
//         next: () => Promise<PostToolDecision>) => Promise<PostToolDecision>
```
- 监听器注册：`ctx.on('tools/post-execute', handler)`，`this` 为 Scoped&lt;ToolRuntime&gt;；**必须 await next() 取默认决策再包装**（协议约束；范例 spill-policy `packages/spill/spill-policy`，README："A `tools/post-execute` waterfall listener (registered with `prepend`, delegating via `next()`)"，并因 read→spill 循环风险显式跳过 `read` 工具——OP 同样跳过 obs_recall/read 类检索工具）。
- 归档 API：`ctx.spillStore.saveText(SaveTextSpill): Promise<SpillRef>`，`SpillRef = { locator, bytes, retrievalHint }`；owner 内建 sessionId 字段。证据：`packages/spill/spill/src/types.ts`（saveText/SpillRef）、local 实现 `packages/spill/spill-local/src/index.ts`（Config root 默认私有 tmp 根 0700；`store.ts` L36–78 `privateRoot()/sessionDir(root, sessionId)` 编码分桶）。派生/子会话继承定位器（capability-seams 已注明）。

(b) **FULL_SENDS=2 宽限（取舍点）**
- dsh 无每请求重投影钩子；持久化等价物是 surface 替换事件：`packages/core/session/src/surface.ts` ——surface 为 log 之上模型可见视图，替换 op 以事件落日志引用原区间（shadowedSeqs/sourceEventSeqs，"The append-only log remains the source of truth"）。现成范例 compaction-tool-result-pruner："swaps each over-budget tool result for one newly appended `tool/result` that replaces the original event and cites it through `sourceEventSeqs`"（README "Pruning mechanics"；紧邻 `compaction/prune` 计价事件）。
- 保真移植方案：post-execute 时只记 pending 列表；在 `agent/pre-step` 计数轮次，第 N(≥2) 步前对超龄条目补一条 surface 替换。简化方案：放弃宽限，首请求即替换为「head/tail 预览 + 定位器」（推荐 Phase B 一并实测两案，倾向简化——dsh 有 spill retrievalHint 缓解一次性信息损失）。

(c) **回读**
- 直接复用 spill 生态：占位符中附 `locator.retrievalHint`，模型经 read 工具 offset/limit/grep 回读（spill-policy 既定 UX）。
- 可选保真件：仍注册 `obs_recall` 自研分页工具（Q1 路径）对 objects 目录分页——列为增强项而非前置件。

### 2.3 与 pi 差异表
| 维度 | pi OP | dsh 方案 |
|---|---|---|
| 改写时机 | context 投影期（每请求、纯内存） | 结果落地时一次（post-execute）+ 可选后补 surface 替换 |
| 宽限 FULL_SENDS=2 | 内建 | 无内建；pre-step 计数补发或直接简化 |
| 归档 | 自管 objects + ledger | spillStore 后端（local 0700；派生会话继承） |
| 日志完整性 | history 不动 | 最终可见内容即日志内容，天然满足 invariant；surface 替换另有留痕 |
| 回读 | obs_recall 分页工具 | locator.hint + read；obs_recall 可选 |
| fail-open | 投影异常→放行原文 | 监听器异常→透传 next() 决策（等价 fail-open，写入探针验证项） |

---

## 3. EPR 证据保存还原器

### 3.1 pi 侧契约回顾
源：`extensions/evidence-preserving-reducer/*`（7 文件全读）
- `pi.on("tool_result")` 重写：候选=bash/AF-fused 输出且命中 `DIAGNOSTIC_COMMAND` 正则，4096B ≤ len ≤ 600k chars，无 LIKELY_SECRET；从 details.fullOutputPath/tmp pi-bash-*.log 取精确字节（realpath 校验）。
- 还原器调用：`context.modelRegistry.complete(model, reqCtx, opts)` + compat 回退（getApiKeyAndHeaders + completeCompat）；`ReducerModelUnavailableError` 降级。90s 超时、maxOutputTokens 2048、默认 openai-codex/gpt-5.6-luna。
- 回执严格验证：schema=`sol-pi-evidence-receipt/1`、source_sha256、status 匹配 isError、quotes 逐字节∈归档、≤12 条×≤600 chars、回执更小否则原样透传。
- 归档：内容寻址 objects（0o700/0o600，wx；EEXIST 字节不符→integrity failure）；journal 经 `pi.appendEntry` 非上下文条目。

### 3.2 dsh 侧接口契约
- **嵌套模型调用**：`ctx.llm.stream(options: GenerateOptions): AsyncIterable<StreamChunk>`。证据：`packages/llm/llm/src/index.ts` L183/L191；GenerateOptions ~L225 起。关键字段：`provider, model, messages, system?, tools?, temperature?, maxTokens?, stop?, signal?, sessionId?, purpose?`；`purpose?: 'compaction' | 'session-title'` 为辅助调用专用标注（闭合联合，EPR 不能新增自有值——未传 purpose 的普通流式调用待 Phase B 验证 replay/缓存隔离性）。
- 调用惯用式（非循环先例，可直接照抄结构）：`packages/compaction/compaction-basic/src/summarizer.ts` ~L110–175——组装 messages（plugin 来源标注 `source:{kind:'plugin', plugin:'dsh-compaction-basic'}`）→ 构造 GenerateOptions → `for await (const chunk of ctx.llm.stream(options)) assembler.push(chunk)` → finish 错误检查。session-title 包同样 inject ['llm','sessions'] 直接消费（`packages/session/session-title/src/index.ts` L296）。
- 鉴权差异：pi 版自管 getApiKeyAndHeaders 兼容层；dsh 由 adapter 层持有凭证（`LlmAdapter` 契约，llm/src/index.ts ~L200 起；"Every provider HTTP request must include attributionHeaders()"）——**EPR 插件代码零凭证接触**，符合"dsh 凭证不进插件"。
- 结果拦截/归档宿主：同 §2 的 `tools/post-execute` 链；监听器顺序 prepend 使 EPR 先于 OP 包装运行。

### 3.3 契约级移植设计
```
监听器（单包内两个阶段，均为 tools/post-execute）:
  [阶段E·EPR] exec.command 匹配 DIAGNOSTIC_COMMAND 正则 && 尺寸窗内 && 无密钥指纹
    → 精确字节获取：StockResultDetails 等价物待 Phase B 对账
      （dsh bash 结果是否携带 full-output 文件句柄；若无，则 EPR 从 result.content 自取全文，
       超长尾部丢失问题转由上游 bash 工具的 maxBuffer 策略决定——登记为开放项 B-EPR-1）
    → spillStore.saveText({ owner.sessionId, text: fullBytes })  // 代替 pi objects 目录
    → ctx.llm.stream({ provider,model, messages:[receiptPrompt(fullBytes)],
        maxTokens: 2048, sessionId, signal: AbortSignal.timeout(90_000) })
    → 逐字段校验回执（schema/source_sha256/status 匹配 isError/quotes∈archive/≤12×600/
       更小才接受；任一失败→透传原结果）
    → next() 后返回 { kind:'accept', content: [receiptText] }
  [阶段O·OP] content 不含回执前缀 && >10KB → spillStore.saveText + 预览替换（§2）
journal/状态持久化：dsh 开发者预览未确认「插件自定义 session entry」公共 API
    （storage-contract 对未知必选事件类型 fail-closed，`session-persistence/storage-contract.ts`
     "refusing to interpret the log"）→ v1 设计：journal 落插件 Config root 下
    `<root>/sessions/<bucket>/journal.jsonl`（与 §4 存储约定一致），不进 session log；
    待 Phase B 向上游确认 ignorable:true 的插件事件可行性后迁移。
model 解析：config.provider/model 必填（cordis.yml 传入），无 pi 版 modelRegistry 链式解析；
    provider/model 不存在时 stream 抛错→捕获降级透传（对应 ReducerModelUnavailableError 语义）。
```

### 3.4 与 pi 差异表
| 维度 | pi | dsh |
|---|---|---|
| 模型调用 | modelRegistry.complete + compat 回退、自管鉴权 | ctx.llm.stream 直连 route；adapter 层鉴权（零 key 接触） |
| purpose 标注 | 无此概念 | purpose:'compaction'\|'session-title' 闭合联合，暂复用不传或 'compaction' 待验 |
| journal | pi.appendEntry 会话条目 | 公共 API 未确认 → 先落插件 root 文件（开放项） |
| full output 获取 | details.fullOutputPath + tmp 日志 realpath | 待验（B-EPR-1）；最坏情形退化为仅处理 ≤600k chars 的 content 全文 |
| 超时/输出上限 | 90s / 2048 tokens（硬编码常量文件 config.ts） | 保持同值但入 Config schema（禁止硬编码进行为，cordis.yml 可调） |

---

## 4. OCC 在线上下文压缩

### 4.1 pi 侧契约回顾
源：`extensions/online-context-compact/{extension.ts,economics.ts,state.ts,...}`
- update_plan 工具捕获进度边界 → economics 判定剩余请求数/breakeven/cache-debt → 触发时 `context.abort()` → `agent_settled` 中 `context.compact({customInstructions})` → `sendMessage(triggerTurn)` 续跑。
- 状态经自定义 ONLINE_STATE_ENTRY 持久化并随会话恢复；POST_COMPACTION_PLAN_REMINDER 提醒重建 plan。

### 4.2 dsh 侧接口契约
- 可整替的压缩服务：`abstract class CompactionEngine extends Service { super(ctx,'compaction') }`，抽象方法 `compactIfNeeded(agent, trigger: 'pressure'|'context-overflow', signal?): Promise<CompactionResult|null>` 与手动 compact；「one implementation per context as `ctx.compaction`」。证据：`packages/compaction/compaction/src/index.ts`（Service 声明段）、capability-seams"Compaction engine"节。
- 触发接线参考：compaction-basic 于插件 apply 内挂 `ctx.on('agent/pre-step')` 做 between-step 压力检查、`ctx.on('agent/request-error')` 捕 CONTEXT_WINDOW_EXCEEDED_CODE 做溢出恢复（`packages/compaction/compaction-basic/src/index.ts` ~L146–200）。手动 `/compact` 由 command-compact 包独立处理（同一 CompactionEngine.manual 入口）。
- 日志词汇内建：`compaction/start|summary|end|prune` 事件（`packages/compaction/compaction/src/types.ts` Events 块）→ OCC 审计轨迹直接复用，无需自造事件类型。
- **关键简化**：pi 版 abort+triggerTurn 四步绕行在 dsh 不需要——判定发生在 pre-step（回合间），压缩同步完成后 loop 自然进入下一步；溢出恢复由 request-error 重试路径承接。这是四机制中 dsh 相对 pi 最显著的架构优位。
- 配置：backend 的 Config schema 全量经 cordis.yml 提供（先例：compaction-basic thresholdRatio/retainRatio/modelPolicies；README "Smallest working composition" 三行组合即挂载点）。自研 backend 不挂载 compaction-basic 即完成替换。

### 4.3 契约级移植设计
```ts
class OnlineContextCompaction extends CompactionEngine {
  // econParams/econState 来自 cordis.yml config（scale/stddevK/reserve/firstScale/margin…）
  //   cache-debt 数学与理由枚举（native_not_compactable/non_positive_saving…）逐条照搬 pi economics.ts
  async compactIfNeeded(agent, trigger, signal) {
    const debt = this.debtTracker.observe(agent)          // writeTokens×ratio − repayments
    if (!shouldCompact(agent, trigger, debt, signal)) return null
    // 1) land compaction/start（引擎基类既有词汇，锁直至 compaction/end）
    // 2) 以 plan 边界为裁剪边界组装保留集（keepRecentTokens 默认 20_000 → Config）
    // 3) ctx.llm.stream 产出 replacement summary（§3.2 惯用式）
    // 4) surface 替换落地 + compaction/end
    // 5) POST_COMPACTION_PLAN_REMINDER 经工具结果附加或 additionalContexts 注入
    return { /* CompactionResult */ }
  }
}
export function apply(ctx, config) {
  ctx.compaction?.dispose?.()                       // 或组合层禁用 compaction-basic
  ctx.addDisposer(ctx.set('compaction', new OnlineContextCompaction(ctx, config)))
}
// update_plan 工具另由本包注册（§1 defineTool 路径）；plan 进度状态存 §5 root
```
- plan-mode 不是对手件：`packages/plan/plan-mode` 是用户审批门控（/plan 命令 + exit_plan_mode），与 OCC 的进度计划无涉——update_plan 由 solpi 包自注册，进度持久化走插件 root 或 session 附件。

### 4.4 与 pi 差异表
| 维度 | pi OCC | dsh OCC-backend |
|---|---|---|
| 触发时机 | turn_end 判定 → abort → settled 补做 → triggerTurn 续跑 | pre-step 同步判定，无需 abort/续跑 |
| 压缩执行 | context.compact（宿主内建） | 引擎自实现完整 pipeline（start→summary→end 事件自带） |
| 溢出恢复 | 无专门路径 | agent/request-error 重试钩子现成 |
| 状态持久化 | 自定义会话条目 + 恢复重建 | v1: 插件 root 文件（同 §3 journal 结论） |
| 手动触发 | 无 | compact 入口被 command-compact 共享 |

---

## 5. 共享基础设施

### 5.1 存储约定（Q5 结论）
- 不耦合 session jsonl 物理布局：`SessionLocation.path` 仅为诊断暴露（"not a consumer-facing query"，`packages/session/session-persistence/src/errors.ts` L85–93）；service 面仅 create/open/flush/stat/list（`.../index.ts` L135 起）。jsonl 目录注释虽称 sessionDir "available for future session-local artifacts"（`session-persistence-jsonl/src/format.ts` L266–271），但那是对 backend 而言，不是插件公共查询。
- 采用 dsh 自家惯例（spill-local 范式）：solpi 包 Config.root（z.string()），默认建议 `$DSH_HOME/sol-pi/`；代码内经 `resolveDshHome()` from `@deepseek-ai/dsh-home-paths`（DSH_HOME env > ~/.dsh，`packages/util/home-paths/src/index.ts`）。目录树：
  `<root>/sessions/<encodeSegment(sessionId)>/objects/<sha256>.txt` + `ledger.jsonl` + `journal.jsonl`
  （内容寻址语义、0700/0600 权限、EEXIST 校验逐条照搬 pi runtime-paths.ts/archive 实现；encodeSegment 可从 spill-local store.ts 导出面直接 import）。

### 5.2 装载（Q6 结论）
- 无 `dsh plugin install` CLI（host/plugin-inventory 相关包核对，全仓无该子命令）。
- 开发期：`pnpm dsh web --patch ./cordis.dev.yml`，patch 内 `- insert: [{ id, name: '<绝对路径到 packages/solpi-dsh/src/index.ts>' }]`（路径必须绝对，教程 `docs/user/develop/basic/index.md`"Your first plugin"）。
- 长期：发布 npm 包入 profile bundles，或维护用户 profile 层 `$DSH_HOME/profiles/<name>/cordis.patch.yml`（双锚点模块解析：dsh 安装树 → profile node_modules；`packages/boot/app-boot/src/profile.ts` 模块头注释、PROFILES_DIR='profiles'、PROFILE_PATCH_FILENAME='cordis.patch.yml'）。

### 5.3 配置传递
单一 `packages/solpi-dsh` 提供 `static Config`（schemastery z 对象）：fusion{enabled,timeoutMs}、pack{thresholdBytes,previewHead/Tail,fullSends?}、reducer{provider,model,maxOutputTokens,timeoutMs,patternAllowlist}、occ{…economics…}、storageRoot。所有数值缺省值集中在 schema defaults（对应 pi config.ts），运行时零环境变量读取（除 DSH_HOME 由 home-paths 承担）。

---

## 6. Phase B 探针清单（按依赖序）

| # | 探针 | 验证目标 | 通过判据 |
|---|---|---|---|
| P1 | hello-plugin + `--patch` 本地装载 | Q6 | patch 插件 apply 生效、ctx.tools.register 成功 |
| P2 | tools/post-execute prepend 监听器追加标记 + next() 包装 | Q2 主干 | 标记出现在模型可见上下文；程序 value 未坏；日志含最终内容 |
| P3 | ctx.spillStore.saveText + locator.retrievalHint 渲染 | Q2 归档 | 占位符含提示词；read 可回读原文；owner/sessionId 正确 |
| P4 | ctx.llm.stream 一次性辅助调用（purpose 缺省 vs 'compaction'） | Q3 | 流式聚合文本正确；观察两种 purpose 是否影响 replay/缓存隔离 |
| P5 | bash 结果 details 对账：fullOutputPath 等价物存在？ | B-EPR-1 | 明确 EPR 精确字节目的可行路径或退化方案 |
| P6 | CompactionEngine 最小子类（log-and-noop）挂载后替代 basic | Q4 | ctx.compaction 解析为子类实例；pre-step/request-error 均可达 |
| P7 | （可选）ignorable 插件事件的公共 API 可行性 | journal 迁移 | 上游答复/源码定论后更新 §3.3 |
| P8 | （可选）ctx.shell 服务面可否承载 then_run | AF 复用 | 决定 §1.3 runCommand 走 shell 服务或自持 spawn |

## 7. 开放问题汇总
1. B-EPR-1（P5）：诊断命令精确字节获取路径。
2. journal/OC状态的会话条目化（P7）：当前以插件 root 文件为准。
3. FULL_SENDS=2 保真 vs 简化：Phase B 实测 surface 补发成本后裁决（§2.2b）。
4. purpose 联合扩展：如 EPR 需专属标注，向上游提案（闭合联合是 API 面）。

---

## 8. Phase B 探针结论（2026-09-11，全部实跑验证）

运行环境：dsh 源码构建（pnpm install 4m47s + build）；驱动 = `DSH_HOME=<隔离目录> pnpm --dir ~/tools/deepseek-harness dsh --profile headless --patch <overlay> "<task>"`；模型路由 = llm-pi-ai hand-declared 网关接本机 pi 的 qwen-proxy（http://<QWEN_PROXY_HOST>:30000/v1 · GLM-5.3-Flash，openai-completions）。探针包：`code/dsh-solpi/packages/probe-solpi/`（重跑说明见其 README；日志存 artifacts/run*.log）。

| 探针 | 结论 | 关键证据 |
|---|---|---|
| P1 装载 | ✅ 绝对路径 insert 生效；out-of-tree 运行时依赖需经 `createRequire(dsh内锚点)` 解析（ESM 不回溯到 dsh 闭包） | run1–run6 启动四连行（apply entered / defineTool resolved / registered / listener installed） |
| P2 拦截主干 | ✅ 三判据全过：(a) 模型可见——GLM 最终回答逐字引用两行 `[solpi-probe]`；(b) value 未触——监听器仅返回 content accept（构造保证），代理流未断；(c) 日志一致——session.v3.jsonl.zstd 的 tool/result 事件最终文本含标记且 pristine 正文完整，`sourceEventSeqs:[17]` 留痕 | run2 log + 会话日志抽取输出 |
| P3 归档面 | ✅ saveText 落盘 0600 文件，59 bytes 与原文逐字节一致（sha256 76e4be88…afb47）；locator+retrievalHint 全文格式："Use read with offset/limit, or grep this path to search within it."；spill-local 布局 `<tmp>/dsh-spill-*/session-<hash>/<hash>-<name>.txt` | run2–6 log + cat 工件 |
| P6 压缩 seam | ✅ CompactionEngine 子类经类形态 default export 接管 'compaction' 槽（basic disabled）；pre-step 逐步触发 `compactIfNeeded(trigger='pressure')` 动态分发命中覆写，返回 null 后回合正常完成 | run6 log（两次触发行） |

### 新确立的架构事实（对 §1–§5 的修订）
1. **压缩触发接线属提供方职责**：abstract CompactionEngine 不含触发器；BasicCompactionEngine 在自己构造器里挂 `agent/pre-step`（pressure）与 `agent/request-error`（CONTEXT_WINDOW_EXCEEDED_CODE 溢出恢复，返回 `{kind:'retry'}` 协议）再动态分发 compactIfNeeded。OCC 移植须自实现同构接线——比 §4.3 原设计更明确，工作量不变量。溢出恢复协议已从源码确认（含 "durable surface progress 可单独作为 retry 凭据" 语义）。
2. **hand-declared 路由必须给凭证**：llm-pi-ai 对无 apiKeyEnv 的自定义网关报 `No API key for provider`；哑值环境变量即可。compat 键首启动可省（qwen-proxy 默认值直通成功）。
3. **服务替换姿势**：`ctx.set('compaction', x)` 与 Service 构造自绑定冲突不可用；正规姿势 = 类形态 default export extends 目标抽象基类 + 组合层 disable 旧行。
4. **P4 降险但未单测**：六次实跑全部经 `ctx.llm` 内部真实流式往返，服务面存活无疑；插件侧直接调用的 API 细节留至 Phase D EPR 需要时顺带验证。

### 对开放问题的更新
- §7.2/7.3 维持；§7.1（B-EPR-1）维持待 P5；新增已知事实见上。FULL_SENDS 取舍输入不变（本轮走的是「首请求即预览」同款路径，被证可行）。

---

## 9. Phase C 实作实录（2026-09-11，AF+OP 全部实跑验收）

### 9.1 交付物
`packages/solpi-dsh/`（out-of-tree 单包多入口）：
- `src/action-fusion.ts` + `src/file-queue.ts` + `src/then-run.ts` —— AF 完整移植
- `src/observation-pack.ts` —— OP 薄封装（决策 B，见 §9.5）
- `cordis.phase-c.yml`（AF 接管 + OP 调阈值 + 双入口）/ `cordis.phase-c-baseline.yml`（同路由、stock tool-fs，作回合对照基线）
- `tests/fused-units.ts`（node strip-types 直跑的单元证据）+ `artifacts/af-e2e-run*.log`、`op-*-run*.log`

### 9.2 AF 移植要点与 pi 偏差登记
组合式：overlay **整体 disable `tool-fs` 行**；插件以 async `apply()` + `await import(pathToFileURL(abs))` 深引 tool-fs src 部件（`applyReadTool/applyReadImageTool` + caps 常量）复用 read 套件原行为，再注册融合 write/edit（含 `then_run` 参数）与瀑布 intent 槽。串行队列按 canonical realpath；护栏 = sha256→yield→sha256 复验。

对 pi 的三处有意偏差：
1. **命令失败不抛**：pi 在 bash 失败时抛错嵌入 mutation 输出；dsh 改为结果携带 `thenRun{status,output,exitCode}` + render 追加 `[then_run:failed]` 后缀——编辑成功不被掩盖。
2. **护栏哈希自解析请求路径**：FsTarget 不透明；远程后端诚实降级为 skip 标记。
3. **无 Config zod 导出**（out-of-tree loader 限制）：insert entry 的 `config` 经 cordis `EntryOptions.config → fiber.update(config)` 原生直传（§5.3 修订为可行路径），插件内部 normalize+fail-fast。

### 9.3 boot 迭代实修缺陷（run1–run5）
1. `inject` 数组漏 `'shell'` ⇒ "cannot get property shell without inject"（cordis 依赖声明即权限）。
2. 结果值 `...outcome` 泄漏 FsWriteOutcome.version ⇒ 被 output-schema 校验拒收（additionalProperties:false）；修正为显式投影 stock 四字段。此 bug 由模型在 run4 会话中自行诊断并报告——模型可见性反哺调试的直接例证。
3. 工具参数 schema 的嵌套对象必须显式 `additionalProperties:false`；联合类型用 oneOf（不接受 type 数组）。
4. llm-pi-ai 的 models[] 需同时给 id 与 name 两键 + `input:[text]`。
5. `pnpm --dir` 把进程 cwd 钉在 harness 根 ⇒ session cwd 与文件落点随之；验收 scratch 改置 `<harness>/.solpi-scratch/`，`--patch` 一律绝对路径（相对路径按该 cwd 解析）。

### 9.4 AF 验收证据（C1 通过规则四判据）
| 判据 | 结果 | 证据 |
|---|---|---|
| 效率方向可辨 | ✅ 同形任务 assistant 回合 3→2 | 融合 session-08cef（write+then_run 单调用）vs 基线 session-493af（write→bash→汇报），均 GLM-5.3-Flash |
| 能力底线维持 | ✅ 文件内容逐字正确、脚本真实执行、输出如实转述 | e2e af-e2e-run5：最终回答含 then_run output verbatim `x1` |
| 无误伤 | ✅ 正常路径护栏触发=0 | run5 全程无 [then_run:skipped] |
| 专项场景 | ✅ 干扰真拦截 | 单元 T3a：yield 窗口内篡改⇒抛 `[then_run:skipped] target content changed…`；T1 同路径严格串行（a-enter,a-exit,b-enter,b-exit）、T2 异路径并发 overlap=true、T3b 未动通过——`node tests/fused-units.ts` exit=0 |

Model-visible ⟺ logged 保持：run5 会话日志 tool/result 文本含 `[then_run:succeeded]` 且正文完整。

### 9.5 OP 关键发现与决策 B（用户拍板）
`--dump-config` 显示 headless 默认树已挂 `spill-local` + `spill-policy`（config maxInlineBytes:50000）；`packages/spill/spill-policy/src/index.ts` 与 C1 评审 o1–o5 缓解逐条同构（尺寸闸门/spillStore 归档/TextRetainer 头尾预览/skip-read 防循环/fail-open）。**重造即重复 harness**——决策 B：
- overlay 将 stock 行阈值调至 pi 对齐值 `maxInlineBytes:10240`（走其真实 Config schema）；
- `observation-pack.ts` 只承担真实增量：启动合成可见性日志 `[solpi-dsh/op]` + **EPR 回执豁免钩子**（prepend 监听器，树序在后 + prepend ⇒ 先于 spill-policy listener 触发；今日纯 next() 透传，Phase D 在此拦截 `sol-pi-evidence-receipt/1` 前缀免打包）；
- 对比含义：OP 在 dsh 为「原生内建」级成本——这是双 harness 结论的核心事实之一，wiki 已录。

### 9.6 OP 验收证据（四断言全绿，session-0d2cfe2e + op-readback-run2）
夹具：big 13672B / small 19B / medium 8280B（<10240）。会话内依序 cat 三文件后追问中部数据。
- **A1 打包形态**：cat big ⇒ 结果文本恰 10239B = 头(L001…)+尾(…TOKEN260) + "(Omitted 3666 bytes. Full formatted result stored at: <TMPDIR>/dsh-spill-qvS4tE/session-…/ba2cefbba776-bash.txt. Use read with offset/limit, or grep this path to search within it.)"；TOKEN137 不在窗口内 ✓
- **A2 归档完整性**：工件 13672B，sha256 == 源 `ee26ed8d…b29b3ab2dcd` ✓
- **A3 小结果逐字 & 无误伤**：small 结果 = `OPSMALL-payload-v1`（19B 原样）；medium 8280B 未打包、180 行全量在场 ✓
- **A4 经归档回读完成任务**：定向任务禁止再读源文件 ⇒ 模型按 hint 用 read offset132–141 读**归档工件**取回 TOKEN137 并声明未触源文件 ✓ 信息缺失失败 ≈0

### 9.7 环境事实增补（承 §8）
6. 会话日志里用户任务文本落在 `agent/inbox/spliced.inserted[].content`（headless 场景无独立 user/message text）——日志解析勿按旧键找。
7. dsh-spill 定位符根在 macOS `$TMPDIR`（/var/folders/...），非 /tmp 字面。
8. overlay 相对路径语义见 §9.3-5；`--dump-config` 是组合树的唯一权威视图。

### 9.8 开放问题收束与新遗留
- §7.3 obs_recall **CLOSED**：不需要——stock `read offset/limit` 直读归档工件即回读协议（A4 实证）。
- §7.2 FULL_SENDS **CLOSED**：随 B 决策落定为「首请求即预览」（原生即此行为；§8 末句同判）。
- 新遗留：(a) out-of-tree Config zod schema 声明仍缺位（现行 = entry config 直传 + 内部校验，可用但少静态防护）；(b) AF 的 edit-only/replaceAll 展示分支代码已覆盖但未获 e2e 自然触发，Phase D 组合验证时回看；(c) EPR 回执豁免钩子激活属 Phase D；(d) P8（ctx.shell 承载 then_run）已实证 CLOSED——AF 即构建其上。

---

## 10. Phase D 实作实录（2026-09-11，EPR 全部实跑验收）

### 10.1 交付物
- `packages/solpi-dsh/src/epr/{config,candidate,archive,journal,receipt,provider}.ts` + 主入口 `src/evidence-preserving-reducer.ts`
- `src/observation-pack.ts` 豁免钩子**激活**（回执前缀 ⇒ 早返回 accept 绕过下游打包器）
- overlay `cordis.phase-d.yml`（AF+OP+EPR 全栈）；单元 `tests/epr-units.ts`、`tests/op-exemption.ts`；日志 `artifacts/epr-*`、`af-e2e-run6.log`

### 10.2 B-EPR-1 定案与 pi 映射
dsh bash 截断契约与 pi 同构：`result.value.stdout.spillPath`（CollectedOutput）+ render 内嵌 `[output truncated; full output: <path>]`；内联上限默认 64KB/流（bash-local maxOutputBytes），spill 上限 maxSpillBytes。candidate 优先 spillPath 文件字节、守卫 regular&非符号链接&tmpdir/dsh-spill 内；fused write/edit 走 marker 后缀切分。observedFailure = isError || exitCode≠0 || thenRun.status==='failed'。

### 10.3 与 pi 的偏差登记
1. **reducer 调用面**：ctx.llm.stream one-shot（GenerateOptions 自带 `system` 字段；purpose 闭联合合不扩展）替代 pi modelRegistry.complete。
2. **finishReason 归一化**：dsh adapter 发 `{"kind":"stop"}` 形态信封——必须剥壳后再比对 stop|length（run3 教训）。
3. **journal**：插件自有 journal.jsonl（spec §3.3 v1 决策维持），非 session 条目。
4. **storeRoot**：`$DSH_HOME/sol-pi/evidence-preserving-reducer/`（§5.1 插件所有根的子目录），runId=sha256(storeRoot)[:16]。
5. **内联体保真度注记**：<64KB 输出的 body 取自渲染卡内文（含 ```console 围栏）；归档与引文校验都在该"模型可见精确字节"集合上进行，>64KB 则为真实原始字节（spillPath）。语义偏差可接受且有界，v2 可改走 details 直取。
6. 模型实际 edit 参数名为 `{file_path, old_string, new_string, replace_all?}`（会话实录），非 C2 期假定的 oldString 驼峰——融合层转发按原样透传故无误。

### 10.4 D0 尖刺定案（两问均有实证）
- **S1 Config**：绝对路径 .ts 入口的 schemastery `Config` 导出被 loader/cordis 原生解析——缺省值物化实证（无 config 时 probeMark='DEFAULT-WAS-USED'）；注意 API 无 `.optional()`，可选字段直接声明不加修饰即可（缺省=undefined 不报错）。§9.8(a) 关闭：三插件统一形态=各导出 Config。
- **S2 one-shot**：qwen-proxy/GLM-5.3-Flash 经 ctx.llm.stream 一次调用聚合文本成功（31 字符真实回答，system 生效）。

### 10.5 验收证据（对照 §9 判据 C1–C7/C8/C9）
| 判据 | 结果 | 证据 |
|---|---|---|
| C1 双来源候选+闸门 | ✅ | epr-units U1a/b、U2a/b、U3a/b/c（14 单元全 PASS，node exit=0） |
| C2 归档等价 | ✅ | run4：artifact 5255B，sha256 == journal.sourceSha256（ee26ed8d 类内容寻址 objects/<h[:2]>/ 结构，0600） |
| C3 回执校验 | ✅ | U4a–f：伪造引文/错哈希/状态错配/failure 无 failure 证据全拒；合法 success(0 evidence) 通过 |
| C4 经济闸 | ✅ | 流程分支 receipt-not-smaller（entry 实现 + receipt 尺寸特性单测 U5） |
| C5 fail-open | ✅ e2e | failopen-run5：timeoutMs=1 ⇒ finishReason=aborted ⇒ journal fallback(model-response-error) ⇒ 原始输出进模型（E0449 在转录中） |
| C6 主场景 | ✅ e2e | run4：`make -s -C .solpi-scratch check`（5205B 日志）⇒ **applied: 5255B → 1480B receipt (5 quotes)**；tool/result 以 `sol_pi_evidence_receipt_v1` 开头、verified_evidence 5 行；模型最终回答逐字引用 fatal 行（信息零丢失）；输入侧 5255→1480B |
| C7 免打包结构 | ✅ | op-exemption 三断言（前缀早返回且 next 未调 / 常规放行 / 中段提及不豁免）；主场景回执 1480B<10240 双保险 |
| C8 Config 方案 | ✅ | 见 §10.4 S1 |
| C9 edit-only 覆盖 | ✅ | af-e2e-run6 会话：edit 带.then_run 成功，tool/result=编辑语+[then_run:succeeded]+`e2`（135B 单结果完成双动作）；模型 verbatim 引用 |

Model-visible ⟺ logged 全程保持：run4 的回执即 tool/result 最终文本。

### 10.6 新遗留
(a) reducer 输出偶发 markdown 包裹风险由 validateReceipt 天然拒收兜底（fail-open），未做提示词加固；(b) >64KB 场景的 spillPath 主路径已实现但未获长输出自然触发（make 夹具上限内）——Phase E 组合验收时用大日志回归；(c) schemastery 无 optional 的发现已入 §10.4，迁移后续新 Config 一律照此书写。

---

## 11. Phase E 实作实录（2026-09-11，OCC 完成四机制收官）

### 11.1 交付物
- `src/occ/{economics,plan,state}.ts`（economics 为 pi 逐字搬运的纯函数；state 改文件持久化）
- 主入口 `src/online-context-compact.ts`：`SolpiCompactionEngine extends BasicCompactionEngine` + `solpi_update_plan` 工具
- overlay `cordis.phase-e.yml`（basic 行 disabled + 全栈插入）与 `cordis.phase-e-hot.yml`（门控可触参数集）；单元 `tests/occ-units.ts`(17)、回归 `tests/epr-spill-regression.ts`(4)

### 11.2 集成架构（决策 A 落地形态）
**唯一覆写点 = 压力分支门控**：子类 `compactIfNeeded('pressure')` 先用 tokenMeter 测量 → `decideCompaction`（七 reason）→ 门关则记日志返回 null，门开则委托父类既有 region/replay/摘要机械并事后 `recordCompaction` 记账（epoch/debt）。溢出恢复、手动压缩、修剪联动全部继承不动——"策略整合"即：**SoL-Pi 决定何时压，dsh 决定怎么压**。
边界源 = 自有 `solpi_update_plan` 工具（execute 第二参 exec.agent.session.id 定位状态键），完成步骤 ⇒ recordBoundary 区间计数。请求计数挂 `session/event` assistant/message。提醒折入摘要块尾部（POST_COMPACTION_PLAN_REMINDER 文本 pi 原样，update_plan→solpi_update_plan 改名）。

### 11.3 与 pi 的偏差登记
1. 状态持久化：session entries ⇒ `$DSH_HOME/sol-pi/online-context-compact/<sessionId>.json`（0600，best-effort）。
2. 提醒以摘要内嵌替代独立 steer 消息（免新消息缝；信息等价）。
3. cacheWriteReadRatio 无原生计量源 ⇒ Config 显式传入（缺省 null ⇒ 经济门自动失效仅余窗口保护）；headless 验收用 1.2 触发。
4. fixedTokens(系统提示) 未扣减（meter 总量口径差），archiveTokens 因此略偏保守——偏差有界且方向安全（更少误压）。
5. CORRECTION:/steer 分叉未移植（dsh headless 无此输入面）；recordCorrection 函数保留待接。

### 11.4 验收证据（对照 E1–E8）
| 判据 | 结果 | 证据 |
|---|---|---|
| E1 economics 保真 | ✅ | occ-units R1–R7 七 reason 逐条 + U-H1/H2 地平线数学（17 PASS） |
| E2 门控双向 | ✅ | 单元 defer/margin/carried-debt；e2e 实录 `gate=deferred…` 与 `gate=economic write=14629 archive=14229 horizon=1 breakeven=0.21` |
| E3 计划工具+持久化 | ✅ | occ-e2e-run2 boundary=false→true；状态文件落盘 |
| E4 子类接管+实压链路 | ✅ | run4(hot)：**6× economic → 6 组 compaction/start\|summary\|end 会话事件**；dump-config 确认 basic disabled+occ 挂载；状态 epoch=6 comp=6 **boundaries=2 intervals=[5,1]**（真实请求计数的边界区间！） |
| E5 提醒折入 | ✅ | compaction/summary 块含 "Online context compaction finished…" ×6 |
| E6 >64KB spillPath 回归 | ✅ | epr-spill-regression：100800B 经 spillPath 全量取回逐字等价；双标记正则修复（bash render `full output:` + spill-policy `Full formatted result stored at:` 两种通知形）；symlink 拒绝回退 inline |
| E7 无误伤 | ✅ | boot smoke 'Say ready' 与 run2 初段 gate=non_positive_saving/horizon_unavailable 行均零压缩动作；普通任务全程正常完成（run4 最终答案三行计数正确） |
| E8 文档 | ✅ | 本节 + notes 追记 + wiki |

### 11.5 四机制组合态观察（Phase E 附产）
全栈会话实录显示天然分层协作：大 cat 输出先被 spill-policy 收敛为预览+定位符；诊断类命令再被 EPR 收敛为回执；tokenMeter 所见始终是**已收敛后**的上下文 ⇒ OCC 的经济门在 dsh 上天然工作于"上游机制之后"，压的是真实会话骨架而非原始洪峰。这与 pi 单层 OCC 直接面对原始输出的形态不同，属系统级正向差异（上游已把可丢信息的部分处理掉）。头部长任务的端到端收益量化仍归 EdgeBench 式长程评测（超出本轮范围）。

### 11.6 新遗留
(a) cacheWriteReadRatio 的原生计量路径（usage 事件聚合）值得上游提案；(b) plan 步骤 id 重复/goal 变更建议已随 advice 返回但未在验收中强制模型遵守；(c) >262k 窗口的 window_protection 路径未实测（需更大窗模型或注入 measurement）。

## 12. 官方化加固实作实录（2026-09-13，遥测 + 去绝对路径 + 文档）

### 12.1 交付物

- `src/anchors.ts`：dsh 安装根发现（SOLPI_DSH_ROOT 环境变量 → 自位置向上探测 monorepo 布局 → 向上探测 node_modules 已安装布局 → fail-fast），导出 `harnessRoot()/dshRequire()/regionModuleUrl()/solPiDir()`。
- `src/telemetry.ts`：常驻遥测，`$DSH_HOME/sol-pi/telemetry/events.jsonl`，schema `solpi-dsh-telemetry/1`；2MB 尺寸轮转保留 .1–.3 环形、0600、fire-and-forget fail-open（失败只计数+每进程一次告警）。
- 五个入口模块全部改用动态锚点，包内不再有任何本机绝对路径（`grep -rn '/Users/' src/` 仅剩注释一处）。
- `packages/solpi-dsh/README.md` 正式版（功能矩阵/配置/存储/遥测排障/偏差清单）；`docs/upstream-proposals.md` 两份 issue 草稿；`solpi-test.sh` 默认导出 SOLPI_DSH_ROOT。
- 新增 `tests/telemetry-units.ts` T1–T4；全套 46 断言全绿。

### 12.2 与 pi 的偏差登记

7. **EPR 诊断族扩展**：DIAGNOSTIC_COMMAND 在 pi v1 家族逐字保留后追加 `node\s+(?:[\w@./=-]+\s+)*--test|npx\s+tsx\s+--test`。动机：session-dfabc 观察到裸 `node --test` 产生未约简的大段诊断输出。双向验证命中六形态、零误报于四反例（echo 形态理论误报与 pi 同行为，不特判）。
8. **遥测机制为本插件新增**（pi 无）：动机是 stdout 日志随重启蒸发——session-dfabc 取证教训（日志轮换覆盖后 27 次摘要缺席根因不可考）。事件面见 README 遥测表；occ-result 携带 summaryBlocks 使摘要缺席从"翻日志推断"变为直接可见布尔量。
9. **OCC 存储根解析时点**：pi 版经 dshHomePath 同步取得；本插件在模块加载期 await 解析并缓存（`solPiCache`），同步路径读缓存。行为等价，实现形态偏差登记于此。

### 12.3 验收证据

- telemetry-units T1–T4（jsonl 合法性/0600/环形轮转保序唯一/fail-open 计数）。
- 四入口模块（epr/occ/action-fusion/op）动态锚点下模块加载 OK；既有五套件回归无损。
- 全包绝对路径扫描：仅 anchors.ts 头注释一处历史叙述，无可执行路径字面量。

