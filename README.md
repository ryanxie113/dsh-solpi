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
- [`docs/upstream-proposals.md`](docs/upstream-proposals.md) — 回馈上游的三份提案草稿
- [`docs/plans/dsh-solpi-spec.md`](docs/plans/dsh-solpi-spec.md) — 完整设计规格与决策记录

## 兼容性

基于 dsh `0.1.5-rc.2`（developer preview）开发与验收；dsh 升级后需重跑对照。

## Community

- 介绍帖：[deepseek-ai/deepseek-harness#6577](https://github.com/deepseek-ai/deepseek-harness/discussions/6577)（Show Your Plugins!）

## License

MIT。本项目为独立实现，未包含其他项目的代码。
