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
