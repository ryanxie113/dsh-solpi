# Phase A 笔记：solpi-ext(pi) ↔ deepseek-harness(dsh) API 对照

> 规则：每一条映射必须落到两个 checkout 里的具体文件路径作为证据，不接受印象式结论。
> 参考坐标：pi 侧 `~/tools/solpi-ext/src/sol-pi/extensions/*`；dsh 侧 `~/tools/deepseek-harness/packages/*`、`docs/capability-seams.md`。

## 已知线索（2026-09-11 初步盘点，待验证）

| # | pi 侧（已读源码确认） | dsh 侧候选 seam | 验证状态 |
|---|---|---|---|
| Q1 工具注册与替换 | `extension.registerTool()` 替换 edit/write，参数含可选 then_run | 插件化工具体系（packages/ 内工具包） | ☐ 待查工具插件的最小样例 |
| Q2 结果拦截 | OP 用 provider-context projection handler 改写进入上下文的观察 | `ctx.toolResultPruner`（宣称 model-free pruning）；hooks 组的 tools 运行时事件 | ☐ 确认 pruner 能否做"归档+句柄替换"而非仅修剪 |
| Q3 嵌套模型调用 | EPR 经 modelRegistry 解析 provider/model | `ctx.llm` adapter registry；llm-deepseek 与 llm-pi-ai 双实现 | ☐ 确认 registry 暴露的调用签名与流式语义 |
| Q4 压缩控制 | OCC 用隐藏 triggerTurn 消息模拟新回合（绕行方案） | `packages/compaction` + `compaction-basic` 为可替换 seam —— 可能是一等公民 | ☐ 找到替换 compaction 的 profile 配置写法 |
| Q5 会话目录存储 | 归档落在 session 目录下 `sol-pi/<session-id>/` | `$DSH_HOME/profiles/<profile>` 外部插件区；session jsonl/sqlite 持久化 | ☐ 找到插件可写的 per-session 目录约定 |
| Q6 外部插件装载 | pi 用 `pi install <path>` 注册用户级扩展 | **`dsh plugin`** 命令安装到 profiles；组合 = profile + ordered patch files | ☐ 实测本地路径安装是否支持（`dsh plugin install ./packages/solpi-dsh`？）|

## Phase B 探针设计（草案）

唯一目标：验证 Q2（结果拦截）。这是四机制中唯一不可替代的前置件。
最小实验 = 一个 hello-plugin：注册自身 + 对某工具输出追加一行标记文本 → 观察 agent 看到的内容是否包含标记。

通过判据：标记稳定出现在模型可见上下文中，且不改坏原始结果。
