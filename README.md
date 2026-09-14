# dsh-solpi

为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 打造的效率增强插件包：
让长任务会话更快、更省、更可观测。

## 四个机制

| 机制 | 解决什么问题 |
|---|---|
| **Action Fusion** | 编辑之后要手动跟进命令？改文件与跑测试在同一个工具调用内完成 |
| **ObservationPack** | 规划阶段需要看完整代码？大段观察免于预览裁剪 |
| **Evidence-Preserving Reducer** | 万行测试日志撑爆上下文？压成一页保引用回执，fatal 行仍可逐字引用 |
| **Online Context Compact** | 上下文只涨不缩？按 token 经济学决定何时压缩、留多少 |

每个机制独立开关，默认全关；组合启用时天然分层协作（详见下文架构观察）。

## 快速开始

```bash
# 将本包作为 bundle 安装到某个 profile
dsh plugin --profile <name> add github:ryanxie113/dsh-solpi

# 启动即自动挂载四机制（stock tool-fs / compaction-basic 由 bundle 层接管）
dsh --profile <name>
```

LLM provider/model 等环境配置由你的 profile 提供。安装细节三通道见
[`packages/solpi-dsh/README.md`](packages/solpi-dsh/README.md)。

## 包结构与文档

- [`packages/solpi-dsh/`](packages/solpi-dsh/) — 插件本体（功能矩阵 / 配置表 /
  存储布局 / 遥测排障 / 设计取舍）
- [`docs/benchmarks.md`](docs/benchmarks.md) — 四轮八臂 A/B 基准：数据支撑的使用边界
- [`docs/upstream-proposals.md`](docs/upstream-proposals.md) — 回馈上游的三份提案草稿
- [`docs/plans/dsh-solpi-spec.md`](docs/plans/dsh-solpi-spec.md) — 完整设计规格与决策记录

## 何时启用各机制（基准结论）

四轮 A/B/归因基准（T1–T4，含同种子长程任务）给出了可操作的使用边界：

- **OCC 在线压缩**：在受限上下文窗口（≲32k）或按输入 token 计费敏感的环境下收益显著——
  基准证实其可将每步发送 token 钉在有界带内（25k 峰值 → 16–19k 震荡），且压缩后信息保真成立
  （38KB 文档压缩后精确数字问答 8/8）。在大窗口且不计费的环境下 gate 现在会自动判定
  `deferred_economic` 待机，零压缩税。
- **EPR 证据回执**：适用于 ≥4KB 的诊断型命令输出族；更小的输出正确直通。与 OP 层叠时大输出
  会先被 OP 溢出，属预期分工。
- **Action Fusion**：在短而聚焦的修改-验证循环中链式触发表现最好；小模型对链式参数的跟随
  稳定性有限，建议配合明确的提示词约定。
- 所有 gate 决策均有 `occ-gate` 遥测事件（writeTokens / breakeven / reason）可事后审计。

## 兼容性

基于 dsh `0.1.5-rc.2`（developer preview）开发与验收；dsh 升级后需重跑对照。

## Community

- 介绍帖：[deepseek-ai/deepseek-harness#6577](https://github.com/deepseek-ai/deepseek-harness/discussions/6577)（Show Your Plugins!）
- 社区索引站已收录并完成认领：[DeepSeek-Harness Plugin Hub](https://www.deepseekharnessmarket.site/plugin/ryanxie113/dsh-solpi)

## License

MIT。本项目为独立实现，未包含其他项目的代码。
