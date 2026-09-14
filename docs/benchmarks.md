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

## T2：多模块修复 + AF 显式引导（4 模块 / 12 用例）

solpi 版提示词硬性要求“每次修改用 thenRun 参数串联验证”，vanilla 版同信息量但按各自生态表述：

| 指标 | vanilla | solpi |
|---|---|---|
| 总时长 | 111.8 s | **544.2 s** |
| LLM 请求数 | 14 | 10 |
| 工具调用 | 25 (bash×8) | 25 (bash×3, read×4) |
| af-then-run 遥测 | — | **0 次触发** |
| 任务完成 | ✅ pass 12 | ✅ pass 12 |

**发现（本轮最有价值）：GLM Flash 幻觉式合规。** stdout 自述“每个 edit 均通过 then_run 串联”，
但 session 流中全部 tool call 的 input 均无 thenRun 键——模型口头报告了不存在的工具用法。
telemetry af-then-run=0 与叙述矛盾是铁证；上午实弹 af×4 成功的唯一区别是更短更聚焦的任务形态。
AF 的实际收益受小模型指令跟随稳定性制约；工具描述强化待做。solpi 臂同时再次被 OCC 压缩风暴拖慢
（16 start / 7 epoch），与 T1 结论一致。

## T3：大文档记忆问答（38KB 事实文档 / 8 个数字题）

强制三步形状（write 全文 → read 全文 → 凭记忆作答）。首轮发现单 request 会话 gate 零触发
（无 step 边界，OCC 不介入单轮内）——改进为三步后才产生有效对照：

| 指标 | vanilla | solpi |
|---|---|---|
| 总时长 | 49.3 s | **200.8 s** |
| 答题得分 | **8/8** | **8/8** |
| 压缩 | 0 | 2 epoch（occ-result totalAfter 19126 → 16530）|
| gate 判定分布 | — | economic×4, non_positive_saving×1 |

**发现：压缩后的信息保真成立。** solpi 臂在 read 全文被压缩成摘要块后，8 个精确数字题全对；
但时长比 vanilla 高 4 倍（summarizer 自身请求开销）。结论与 T1 一致：在 262k 窗口远未吃紧时，
OCC 是“质量无损但纯亏时间”的状态；它的价值区在窗口/成本受限的长会话。

## 初版综合画像（T1–T3 六臂）

1. 当前网关（GLM Flash）+ 默认配置下，四机制在短会话上无可测收益、只有开销；亏损主因单一且可配置规避。
2. 三个机制边界事实首次实证：①小模型会幻觉式跳过 thenRun；②OCC 只在 step 边界评估；③摘要化后数字级事实保真可达。
3. 插件的目标场景收敛假设：上下文逼近窗口上限或输入 token 成本敏感的多步长会话。此假设需 T4（逼近 262k 的长程演进任务）验证，本轮未覆盖。

## 待办

- [x] T2 已跑：AF 零触发（GLM Flash 幻觉式合规，telemetry 抓到铁证）
- [x] T3 已跑：38KB 文档记忆问答，压缩后 8/8 保真成立但时长 ×4
- [ ] 提高 n（≥3 取中位）；补 inputTokens 计量通道（adapter usage 不落 session 流，
      可从 telemetry occ-gate writeTokens 序列近似）
- [ ] 把"summarizer 成本计入 breakeven"作为第四条上游提案候选（本轮实测的直接产物）
