# Phase C 设计 Review：AF / OP 的判别三问

> 前置文件：`docs/plans/dsh-solpi-spec.md` §8（Phase B 实跑结论）
> 出处声明：「判别三问」是本项目页（wiki/projects/dsh-solpi-port.md 关键决策节）对 SoL-Pi 方法论的蒸馏术语；
> 其原理根基为 NVlabs SoL-Pi 博客的三条验收原则（`llm-wiki/raw/articles/2026-09-11-nvlabs-sol-pi-blog.md` L85–87，逐条摘录见下），
> 及 SoLPi-ELI5 页的机制级门禁清单（证据一条不少 / 节省须偿付成本 / 拒绝清单：提前收工跳过验证、藏起必要证据、粗暴截断、考题开小灶）。

## 0. 方法论锚点（原文）

1. **Token efficiency favors reusable improvements** — "optimizing on a closed task set invites benchmark overfitting…Token efficiency directs search toward waste recurring across tasks — does not depend on knowing particular-task answers, so transfers better."（博客 L85）
2. **Capability floor rules out savings from doing less** — 所有能力指标 ≥ 容差 ∧ 至少一项效率指标提升。（同上句尾 + 项目页关键决策）
3. **Long-horizon measurability** — "on short tasks, context replay / large outputs / cache writes / extra turns have little time to accumulate; over hours same waste recurs many times making differences measurable."（博客 L87）

由此得判别三问模板：
**Q-a 这个机制消的是什么浪费？是否跨任务复发而非考题特化？**
**Q-b 它何时失效甚至变负收益？（含门禁清单冲突点）**
**Q-c 在 dsh 本部署上如何判定有收益——落到哪些可观测信号？**

---

## 1. AF（动作融合）on dsh

### Q-a 消除的浪费
pi 版事实：edit/write 完成后模型须再发独立 bash 回合等待 lint/test 反馈——每循环多一个 model round-trip、一次完整上下文前缀重放（cache write 代价）与排队延迟。这是「编辑→验证」工作流的**跨任务复发浪费**（对应博客 taxonomoy 的 extra turns + context replay/cache writes），非考题特化。
dsh 移植形态：fused edit/write 带 `then_run` 参数 + per-path 串行队列 + sha256 前后干扰护栏（护栏语义照搬 solpi-ext `action-fusion/{index.ts,then-run.ts,file-queue.ts}`）。

### Q-b 失效/负收益模式
| # | 模式 | 缓解 |
|---|---|---|
| b1 | `then_run` 为长命令时融合结果延迟返回；模型并行编辑其他文件时被 per-path 队列串行化拖慢 | 队列按规范路径分桶仅隔离同文件写竞争（与 pi 一致）；不同路径并发不受影响 |
| b2 | 验证本身不必要/昂贵的任务中被滥用 | 参数可选、由模型自主决定；系统提示不主动怂恿 |
| b3 | 融合输出超大 → 下游 OP 又做归档替换（两机制叠加成本） | 记账为已知组合代价（ELI5 门禁：四机制叠加保留 ~94% 平均分）；Phase E 组合校验盯总量 |
| b4 | 护栏 sha256 全量比对在大文件上的 CPU/IO 开销 | 仅 when_run 执行前后各一次，且仅在配置开启 fusion 时生效 |
| b5 | `[then_run:failed]` 标记被模型误读引发重试风暴 | 标记文本保持 pi 版精确措辞；验收任务断言失败路径行为 |
| 门禁核对 | 不跳过验证✓（融合恰是强化验证闭环）；不藏证据✓（命令原样进融合输出，OP 层只动体积不动存在性）；非考题特化✓（机制通用） |

### Q-c dsh 可测信号（C2 验收即按此设计）
- **turn 数**：同一「改文件→跑校验」任务集，fused vs stock 的 assistant/message 计数（会话日志直接数）——预期显著降低。
- **效率**：墙钟时间；如 token-meter 服务可用则加每 turn input tokens。
- **功能正确性（地板）**：目标文件终态 diff == 期望（融合不得改变编辑语义）。
- **行为分布**：日志统计 `then_run:succeeded|failed|skipped` 分布合理、正常运行为护栏触发=0。
- **护栏有效性专项**：人为注入「then_run 期间外部篡改目标文件」的场景，断言任务以 fail 标记收场且篡改可见——证明护栏真的在工作而非摆设。

---

## 2. OP（观察包）on dsh

### Q-a 消除的浪费
大体积工具输出一旦进入上下文便随每个后续请求重放（input cost × 请求数），并抬升压缩边界的 summary 输入规模。博客点名 large outputs / context replay 属长程累积浪费。dsh 已证链路（Phase B）：`tools/post-execute` 内容替换 + `ctx.spillStore.saveText` 归档 + locator/retrievalHint 进上下文。
**移植采用简化案（已拍板）**：首请求即预览（放弃 FULL_SENDS=2 宽限），回读走 spill 惯用的 read offset/limit（obs_recall 列 backlog）。

### Q-b 失效/负收益模式
| # | 模式 | 缓解 |
|---|---|---|
| o1 | 模型确实需要全文才能决策 → 预览致瞎干、重试轮次反增（正撞门禁"藏起必要证据"） | 替换文案必带精确 locator + 可操作 read/grep 指令（retrievalHint 已内建）；验收含「回读后正确作答」场景 |
| o2 | 略超阈值结果的替换+提示词字节逼近原文 | 沿用 spill-policy 的 reservation 数学（替换承诺 ≤ cap 净缩，源码级保证） |
| o3 | 小结果无谓 spill（文件污染） | 只处理 > threshold 的纯文本；read 类检索工具显式跳过（防 read→spill→read 循环，Phase B 已验姿势） |
| o4 | 结构化/图像结果被错误压平 | 非全 text content 直接透传（flattenPlainText 返回 undefined 即放行的既有守卫） |
| o5 | 与 EPR 叠加顺序耦合 | EPR 回执内容豁免 OP 重写——Phase D 接线时落实，本轮在监听器预留前缀检测钩子 |
| 门禁核对 | 不藏证据的实质=**证据仍一字不少地存在于可寻址工件+回读通路**✓；非截断式粗暴压缩=**head/tail+精确计数告知 omitted 字节数**✓ |

### Q-c dsh 可测信号
- **每 turn input 字节/ token 曲线**：含大输出任务集，OP on vs off（token-meter 或日志侧 request/context 事件体量）。
- **地板**：任务作答正确率不降——尤其依赖大输出的任务必须能经回读答对。
- **替换质量**：spill 命中率（>threshold 且纯文本的结果全部产生 locator）；替换体 ≤ threshold（reservation 不变量）。
- **回读有效性**：最终回答引用了回读内容（或显式复述 locator 内信息）的任务占比；「找不到信息」类失败的占比 ≈ 0。
- **无误伤**：< threshold 的结果在日志中与关闭态逐字节相同。

---

## 3. 判定规则（C2/C3 通过标准汇总）

每个机制的 headless 验收集须同时满足：
1. 效率信号方向正确且幅度可辨（turn 数 / 字节曲线，至少一项明确改善）;
2. 能力地板全部守住（编辑语义不变 / 作答正确率不掉）;
3. 行为分布符合预期、无护栏/替换误伤事故;
4. 两项专项场景通过（AF: 护栏真实拦截篡改; OP: 经回读完成任务）。

短任务盲区声明（诚实记账）：headless 单任务是博客 L87 所指的「short tasks」区段，测到的是机制行为正确性与即时效率方向，**不是 EdgeBench 式长程累积收益**——后者属 Phase E 组合校验范畴，届时用长任务脚本补齐。此偏差已记录，不影响 C 阶段通过判定。
