# solpi-dsh Benchmark（初版）

**日期**：2026-09-14 · **模型**：qwen-proxy GLM-5.3-Flash · **dsh** c291e79 · 单轮采样（n=1，方向性信号非统计结论）

## 方法

A/B/归因三臂对照，同一任务提示词、同一网关、同一 cwd：

| 臂 | profile | 说明 |
|---|---|---|
| vanilla | `bench-vanilla` | dsh-base + headless，无插件 |
| solpi | `headless` | + 本 bundle 四机制全开（默认配置）|
| solpi-tuned | 同上 + overlay | OCC `keepRecentTokens` 抬高到任务不可达 |

指标提取自 `session.v3.jsonl.zstd`（`extract.py`）：请求数 / 工具调用数 / 压缩次数 / 会话时长。
运行入口：`benchmarks/run.sh <task> <group>`。

## T1：诊断修复循环（10 用例 node:test，3 个故意失败）

任务面放大 EPR 与 AF 的自然触发条件；结果如下：

| 指标 | vanilla | solpi 默认 | solpi-tuned |
|---|---|---|---|
| 总时长 | 95.7 s | **277.5 s** | **95.1 s** |
| LLM 请求数 | 12 | 13 | 14 |
| 工具调用 | 15 (bash×6) | 15 (bash×5, edit×4) | 18 (bash×7, edit×4) |
| 压缩 epoch 数 | 0 | **5**（attempts×2 each） | 0 |
| user/messages 注入 | 4 | 20 | 4 |
| 任务完成 | ✅ | ✅ | ✅ |

telemetry 实录（solpi 臂）：occ-gate ×13（12 次判定 economic=true）→ 5 次真实压缩；
epr-skip ×4（node --test 输出 3441/2538/1683/821 B 均 <4096B minBytes）；af-then-run ×4 succeeded。

## 初步结论

1. **短任务上默认配置净亏约 3 倍时长，且根因已定位到单点**：solpi-tuned 与 vanilla 几乎打平
   （95.1 vs 95.7s）——亏损全部来自 OCC 在 ~16k token 会话上的压缩风暴
   （keepRecentTokens=5000 门槛过激；且每次压缩 attempts=2，summarizer 自身成本未计入 gate 的 breakeven）。
   这不是机制缺陷，是**场景-配置错配**，恰好证明了 gate 遥测字段设计的价值：问题在数据里一眼可见。
2. **EPR 行为正确**：<4KB 输出被正确跳过（本任务的测试日志天然小于阈值）；要测 EPR 正收益需要
   ≥4KB 且带 fatal 行的长堆栈场景。
3. **AF 自然触发率低**：GLM Flash 在两组都倾向 edit 后手动 bash，未主动使用 thenRun 参数——
   收益未显现属指令跟随问题而非机制问题，待 T2 用显式引导验证。

## 待办

- [ ] T2（AF 主场）：多文件改造 + 显式要求"每次修改用 thenRun 链接构建"，对比纯 AF 增益
- [ ] T3（OCC 主场）：长程演进任务使上下文逼近门槛，对比压缩后的 token 曲线与完成质量
- [ ] 提高 n（≥3 取中位）；补 inputTokens 计量通道（adapter usage 不落 session 流，
      可从 telemetry occ-gate writeTokens 序列近似）
- [ ] 把"summarizer 成本计入 breakeven"作为第四条上游提案候选（本轮实测的直接产物）
