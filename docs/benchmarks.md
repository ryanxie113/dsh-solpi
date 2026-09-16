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

## T4：长程逐模块修复（12 模块 / 36 用例 / 每轮测试输出 ~5–6KB）

同种子生成器（seed 固定，两臂拿到完全相同的 bug 集）；solpi 先跑，vanilla 重生成种子后跑
（首跑时 vanilla 吃到共享目录已被修复的状态，其验尸报告 mtime 取证拒绝编造工作，本身是个亮点）：

| 指标 | vanilla | solpi |
|---|---|---|
| 总时长 | **103 s** | 1168 s（19.5 min）|
| LLM 请求数 | 21 | 52 |
| 工具调用 | 48 (write×12, bash×16, read×16) | 67 (bash×30, write×13, read×16) |
| 压缩 | 0（原生也未触发） | 22 epoch（73 start） |
| 任务完成质量 | ✅ 36/36 pass 无 SKIP | ✅ 36/36 pass 无 SKIP |
| epr-applied / skip | — | **1 / 26** |

### 四个关键发现

> **勘误（T5 复测后）**：本节第 4 条“EPR 被 OP 层叠挤压”为错误归因，已由后续实验推翻，见下方
> 「EPR 归因修正」节。真凶是 reducer 模型 max-tokens 输出失控；OP 不在责任链上。

1. **writeTokens 曲线证实 OCC 的机制效力：** solpi 臂从爬升峰位 24970 被持续压回 16–19k 震荡带
   （每步发送 token 有界化成立）——但在 262k 窗口 + 免费网关下这一属性无变现。
2. **本规模长任务（总量 <60k tokens）四机制零收益、11 倍时长亏损。** 亏损主体仍是压缩 summarizer
   自身请求；原生 compaction-basic 在 vanilla 全程 0 触发——两边离各自的压力区都很远。
3. **EPR 被 OP 前置层叠挤压：** 26 次 epr-skip(below-min-bytes) 的主因是 OP(maxInlineBytes=10240)
   已先把大 tool result 溢出为引用，EPR 到手的内容多数已小于 4KB。机制重叠 → 提案素材：
   bash 测试输出族对 OP 豁免或 OP→EPR 让渡协调。
4. **场景假设最终收敛（比预期更窄）：** 现实价值区 = 受限窗口模型（<32k）或按输入 token 计费昂贵的
   环境；当前 qwen-proxy/GLM Flash + 262k 免费窗口两条都不满足。T4 所测的"逼近 262k"拐点
   需要十倍任务规模才能触及，超出本轮预算，未验证。

## 初版综合画像（T1–T3 六臂）

1. 当前网关（GLM Flash）+ 默认配置下，四机制在短会话上无可测收益、只有开销；亏损主因单一且可配置规避。
2. 三个机制边界事实首次实证：①小模型会幻觉式跳过 thenRun；②OCC 只在 step 边界评估；③摘要化后数字级事实保真可达。
3. 插件的目标场景收敛假设（T4 后修订）：受限窗口（<32k）或高单价输入 token 场景；
   262k 充足窗口下全场景默认关闭 OCC 为最优策略。

## 经济学修正验证（T1 复测，summarizer 成本入账）

T4 后实施修复：breakeven 分子计入 summarizer 自身执行成本
（`(archiveTokens + memoTokens) × summarizerCostScale=1`）。同任务 T1 solpi 臂复跑：

| | 修正前 | 修正后 |
|---|---|---|
| gate 判定分布 | economic×12 | **deferred_economic×10**, economic×1, non_positive_saving×1 |
| 压缩落地 epoch | 5 | **1** |
| 总时长 | 277.5 s | **127.6 s**（vanilla 基线 95.7 s）|
| 任务质量 | ✅ | ✅ |

压缩税从 3x 降至 ~33%；残余差异 = 单次首压（firstCompactionRequestScale=2 攤销后的擦边决策）
+ plan 工具注入。gate 现在会在长 horizon/大 archive 时才放行压缩——与设计意图一致。
需更保守可将 `summarizerCostScale` 上调或 `firstCompactionRequestScale` 归一。

## AF 幻觉合规修复（T2 复测）

两段式修复后 AF 从完全失效到 100% 兑现：

1. **静态层**：then_run 描述改为行动导向（“one round trip instead of two / ALWAYS put that
   command here”）；benchmark 提示词参数名统一为 schema 真实字段 `then_run`（snake_case）。
2. **运行时教练**：edit/write 未带 then_run 时在 tool result 尾部追加 `[af-coach]` 提示行
   （零配置；中途曾因变量未定义报错——讽刺的是该报错本身就把模型逼上了正道，错误反馈的
   行为塑形力强于描述文本，已作为观察记录在案）。

| 阶段 | 真实链式融合 | af-then-run 遥测 | requests |
|---|---|---|---|
| 修正前 | **0/13** | 0 且无 session 字段 | — |
| 描述强化后 | 0/13（仍幻觉） | — | — |
| + 运行时 coach | **13/13** | 26 条 | 12 |
| 终版（埋点补 session） | 13/13，coach 触发 0 次 | 13 条全带 session | **11** |

终版质量 pass 12，requests 反超 vanilla（14）。遥测埋点同时重构：af-then-run 从渲染层
迁至 fused pipeline 执行点并携带 session id，渲染函数回归纯函数。

## EPR 归因修正 + 两处遥测/重试修复（T5 专项，2026-09-14 晚）

针对「OP 层叠挤压 EPR」假设做了专项复验（同种子项目只修 2 模块 × 3 轮）：**假设被推翻**。

真实机制链：

1. **单文件 `node --test` 失败输出天生紧凑（1733–3368B < minBytes=4096），EPR 无候选是正确行为**——
   只有全量 `npm test`（~70KB）才会过阈。T4 的 26 次 skip 中绝大多数是真 below-min-bytes。
   EPR 的主场是 webpack/tsc/esbuild 级别的构建日志，不是 node:test 的紧凑失败渲染。
2. **大候选的真凶是 reducer 输出失控**：journal 显示 6 次 provider 失败全部为
   `finishReason=max-tokens`（GLM Flash 对 receipt JSON 指令置之不理狂输至 2048 token 掐断）。
   **修复：入口层对 max-tokens 自动重试一次**，system 追加硬约束
   （≤5 evidence items、quote ≤200 chars）；mock 单测 U6a–U6e 钉死该通路（含持续失控 fail-open）。
3. **两处遥测缺陷顺手修复**：①`epr-skip` 此前对所有候选无条件误发（大候选被计成 skip）；
   ②非诊断命令原本无声消失 → 新增 `not-diagnostic` 事件并附 cmdPrefix，
   T5 实测成功拦截一条 `ls -laR`（2104B）。

## 三项修复后的全量复跑（2026-09-14 晚，第二轮验证）

vanilla 臂未动不重跑；solpi 臂重测 vs 各自历史基线。额外发现并修复了第三个病灶
（OCC summarizer 截断风暴），已在本轮 T3 中实战验证熔断生效。

| 任务 | 修正前基线 | 复跑结果 | 判定 |
|---|---|---|---|
| T1 诊断修复循环 | 277.5s / 13 req（压缩风暴） | **116.1s / 8 req**（修正后首测 127.6s，两轮一致） | ✅ −58%，距 vanilla (95.7s) 仅余 +21% |
| T2 链式编辑 | 544s（幻觉合规）/ AF 修复后 255s | 284s；then_run 融合 4 次（1 成功 3 失败即写入后验证暴露问题，符合设计）、coach 触发 2 次 | ✅ ≈−48%；模型使用率有轮次波动（上轮 13/13，本轮部分手动），单轮采样噪声需均值平滑 |
| T3 文档记忆问答 | 200.8s / 2 epoch / 8 保真分 | **133.6s / 0 epoch** / **8/8 保真全对**；中途两次 token-cap 截断 → 熔断器打开拦住后续重试 | ✅ −33%，且保真不掉分 |
| T4 长程逐模块 | 1168s / 22 epoch / 36 保真分 | **230.0s** / economic×2（均被截断）→ 熔断器拦截后续 40 次 gate / **36/36 保真全对** | ✅ **−80%**（2026-09-15 补跑） |

### T4 补跑归因（2026-09-15）：−80% 从何而来

三轮修复叠加后在最大亏损场景上的分解：

1. **gate 经济修正**拒绝边际压缩：`economic` 判定仅 2 次（基线是 22 个 epoch 强制落地）；
2. 两次尝试都被 summarizer token-cap 截断 → **熔断器**第 2 败后打开，本会话剩余
   40 个 step 边界全部 `summarizer_circuit_open` 拦截——零空烧；
3. fail-open 落到"高水位 vanilla 式"运行：writeTokens 中位 47k、峰值 58k
   （基线被钉在 16–19k 带、爬升峰 25k），**这个场景下不压缩反而最快**——
   与场景假设终版一致（262k 免费窗口应默认关 OCC；现由修正后的 gate + 熔断自动实现）。

诚实的另一面：−80% 主要来自"停止无效干预"，不是新机制创造了价值。
EPR 本轮 26 次 skip 全部判定健康（23 真 below-min-bytes + 3 not-diagnostic 带 cmdPrefix）。

## T6 双轮实验：EPR 主场定位（2026-09-15）

四机制中 EPR 是唯一缺正向实证的。t6-epr-home（自由发挥）与 t6-epr-force
（提示词强制直接回显）双轮对照给出了生态位终版：

| 轮 | 模型策略 | EPR 结果 | 质量 |
|---|---|---|---|
| home | 自建 `npm test \| grep` 摘要管道 + 落盘 log 分片读，**零大输出回显** | skip×19 全部正确（含 38KB grep 产物判 not-diagnostic）、applied=0 | 36/36 ✓ |
| force | 提示词禁止重定向/管道/落盘，强制看完整终端输出 | **applied ×2：19782B→1487B（13.3×,6 evidence）/ 19784B→1099B（18×,2 evidence）**——插件史上最大源输出被约简 | 36/36 ✓ |

结论三条：
1. **applied 路径首次实证可用**：约简比、evidence 数、修复保真全部符合设计；
   journal 与 objects 存档链路同轮验证。
2. **生态位修正**：现代模型的上下文经济策略（落盘-分片读-摘要行）天然绕开 EPR，
   触发率趋零是预期行为而非缺陷。EPR 主场 = 弱模型 / 流式不可落盘输出 / 强制回显。
   README「何时启用」节已同步改写。
3. 附带战果：coach v2 效果跨任务延续（home 轮 write 融合 12/12 零教练；force 轮 11 条融合事件），
   OCC 熔断器继续工作（force 轮 circuit_open×21 拦截）。

## T2 稳定性实验：coach 内联示例（2026-09-15，N=3 vs N=3）

then_run 采纳率轮次间波动（0↔13 次/轮）被定位到教练文案缺形状示范。
多轮聚合基建 `benchmarks/aggregate.py`（metrics.json + mtime 遥测窗口切分）支撑本实验。

| 组（各 3 轮） | wall | 零融合轮数 | 成功融合/轮 |
|---|---|---|---|
| coach v1 抽象指令 | 288.9s [170–350] | 2/3 | 2.0 [0–6] |
| coach v2 +内联 JSON 示例 | 240.8s [235–248] | 0/3 | 10.0 [6–12] |

要点：v1 教练触发 10/7 次而模型照旧手动 bash×15——错误形状的反馈必须带
可抄的 schema 形状才塑得动 GLM Flash；v2 方差区间从 180s 收窄到 13s。
af-then-run 的 failed 高占比属设计语义（写入即验证暴露未完成状态），非缺陷。
诚实边界：N=3，幅度置信度有限，方向一致性是该结论的主要依据。

### 本轮新发现与修复：OCC summarizer 截断风暴

T3 首轮复跑中 5 次 compaction 全部死于 `summarization truncated at the token cap`
（GLM Flash 输出失控被 token 上限掊断，checkpoint 不完整），而 gate 无失败记忆、
每个 step 边界照旧批经济闸 → 重试风暴烧掉 ~100s。这与 EPR 的 max-tokens 是同一疾病
（小模型输出失控）的两个器官。

**修复（熔断器）**：state 新增 `summarizerFailures` 连败计数，≥2 后本会话 gate 直接
返回 `summarizer_circuit_open`（compact=false，fail-open 到 vanilla 压力路径）；
成功落地即清零。复跑实测：2 次截断后熔断打开，后续 gate 全部拦截，不再空烧。

- [x] T2 已跑：AF 零触发（GLM Flash 幻觉式合规，telemetry 抓到铁证）
- [x] T3 已跑：38KB 文档记忆问答，压缩后 8/8 保真成立但时长 ×4
- [ ] 提高 n（≥3 取中位）；补 inputTokens 计量通道（adapter usage 不落 session 流，
      可从 telemetry occ-gate writeTokens 序列近似）
[x] summarizer 成本已入 breakeven（见经济修正验证节）；第四提案转为已落地修复
[x] OP–EPR「层叠挤压」已证伪并撤回（T5 专项）；真凶 reducer max-tokens 失控 → tight-retry 已落地；EPR 主场=构建日志型输出，node:test 场景无候选属正确
