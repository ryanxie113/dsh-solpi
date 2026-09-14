# solpi-dsh — SoL-Pi 四机制 × DeepSeek Harness 移植

<p align="center">
  <img src="./dsh_solpi.png" alt="solpi-dsh cover: Action Fusion · ObservationPack · Evidence-Preserving Reducer · Online Context Compact" width="720">
</p>

> 把 pi（SoL-Pi）的四个效率机制移植为 dsh 树外插件：**Action Fusion**（编辑+跟进命令融合）、
> **ObservationPack**（大输出豁免压缩）、**Evidence-Preserving Reducer**（保证据诊断约简）、
> **Online Context Compact**（在线上下文经济压缩）。

设计规格与全部决策记录见仓库根 `docs/plans/dsh-solpi-spec.md`。

## 功能矩阵

| 机制 | 入口模块 | 触发条件 | 输出 |
|---|---|---|---|
| Action Fusion | `src/action-fusion.ts` | edit/write 工具带 `thenRun` 参数 | 单次工具调用内完成「改文件→跑命令」，结果以 `[then_run:succeeded/failed/skipped]` 标记附加 |
| ObservationPack | `src/observation-pack.ts` | 工具结果含大段代码块且会话处于 plan 模式 | 豁免该轮 spill-policy 压缩，完整保留观察 |
| EPR | `src/evidence-preserving-reducer.ts` | 命中诊断命令族（npm/pnpm/yarn/vitest/jest/go/bazel/**node --test / npx tsx --test**）且输出 ≥ minBytes | 约 1KB 保引用 receipt 替换原输出；原全文落盘 `$DSH_HOME/sol-pi/epr/` |
| OCC | `src/online-context-compact.ts` | token 经济门槛（keepRecent/ratio/估算 Horizon） | 区间压缩，边界与计量记入状态文件 |

公共基建：`src/anchors.ts`（dsh 安装根双布局发现）、`src/telemetry.ts`（常驻遥测）。

## 安装根发现（anchors）

树外加载无法裸解析 `@deepseek-ai/*`，所有内部依赖经锚定 require 解决。发现顺序：

1. `SOLPI_DSH_ROOT` 环境变量（显式逃生门）
2. 从插件自身位置逐级向上探测 monorepo 布局（`packages/compaction/compaction-basic/src/region.ts` 探针）
3. 同样向上探测已安装布局（`node_modules/@deepseek-ai/dsh-home-paths`）

失败即 fail-fast 报错并提示设置环境变量——绝不静默错路由。

## 安装（bundle 形态）

本包按 dsh 官方 bundle 约定发布（`dsh.bundle` 声明 + `cordis.patch.yml` 层），三种
安装通道任选：

```sh
# 本地检出 link（开发推荐）
dsh plugin --profile <name> add ./packages/solpi-dsh

# GitHub 直装（首次需在 profile 的 pnpm-workspace.yaml 里 allowBuilds）
dsh plugin --profile <name> add github:<you>/solpi-dsh#<sha>

# npm / tarball（最顺滑，无需构建权限）
dsh plugin --profile <name> add solpi-dsh
dsh plugin --profile <name> add ./solpi-dsh-0.1.0.tgz
```

安装后 boot 即自动挂载四机制并接管 stock tool-fs / compaction-basic 行（详见包内
`cordis.patch.yml`）。LLM provider/model 等环境配置仍由用户 patch/profile 提供——
参考仓库根 `cordis.phase-e-web-long.yml` 的 llm 段。

> **region 依赖说明**：OCC 的区间选择复用 compaction-basic 的 region 实现。monorepo
> 源码检出形态直接可达；纯 npm 形态需上游公开该导出面后才可用（见
> `docs/upstream-proposals.md` 提案 3），此前会 fail-fast 明报。

## 手动挂载示例（overlay 形态，源码直跑）

```yaml
- insert:
    - id: solpi-dsh-occ
      name: '/abs/path/to/packages/solpi-dsh/src/online-context-compact.ts'
      config:
        keepRecentTokens: 5000
        cacheWriteReadRatio: 1.4
        summaryTokenEstimate: 700
    - id: solpi-dsh-epr
      name: '/abs/path/to/packages/solpi-dsh/src/evidence-preserving-reducer.ts'
      # 可选覆盖: minBytes/maxChars/reducerProvider/reducerModel/maxOutputTokens/timeoutMs
```

EPR 运行时依赖 summarizer 服务；OCC 深度复用 compaction-basic 的 region 压缩实现
（动态导入其 `src/region.ts`）。完整可跑样例见 `cordis.phase-{c,d,e,e-web-long}.yml`
与根目录 `solpi-test.sh`。

## 存储

全部落在 `$DSH_HOME/sol-pi/` 下，权限 0600：

```
$DSH_HOME/sol-pi/
├── online-context-compact/<session>.json   # OCC 状态
├── epr/<runId>/…                           # EPR 原文归档 + journal.jsonl
└── telemetry/events.jsonl                  # 本插件遥测（见下）
```

## 遥测（events.jsonl）

每事件一行 JSON，schema `solpi-dsh-telemetry/1`，字段 `{t, schema, kind, …}`。
写入为 fire-and-forget、fail-open（失败只计数+一次告警，绝不影响会话）；
单文件 2MB 轮转、保留 .1–.3 三代（环形丢弃最老代）。

| kind | 时机 | 关键字段 |
|---|---|---|
| `occ-gate` | 每次压力检查 | reason/writeTokens/archiveTokens/horizon/breakeven/compact |
| `occ-result` | 压缩落地后 | epoch/attempts/summaryBlocks/totalAfter —— **summaryBlocks 为 null 即"摘要缺席"直接可见** |
| `af-then-run` | 融合 then_run 终态 | status = succeeded/failed/skipped(+reason) |
| `epr-applied` | receipt 成功替换原文 | sourceBytes/receiptBytes/evidenceCount |
| `epr-skip` | 命中诊断族但体积过小 | reason=below-min-bytes/bytes/minBytes |

排障：事件丢失先看进程 stdout 是否有唯一一条 `[solpi-dsh/telemetry] event dropped`，
再查 `$DSH_HOME` 可写性。轮转历史在 `events.jsonl.1`–`.3`。

## 测试

```bash
cd packages/solpi-dsh
for t in fused-units epr-units occ-units op-exemption telemetry-units epr-spill-regression; do
  node --experimental-strip-types tests/$t.ts
done
```

当前 46 断言全绿。

## 已知偏差（相对 pi 原版）

1. **EPR 诊断族扩展**（registered deviation, spec §10.3）：pi v1 家族逐字保留，
   追加 `node --test` 族与 `npx tsx --test`。动机：session-dfabc 观察到裸
   `node --test` 产生未约简的大段诊断输出。
2. **echo 形态理论误报不特判**：`echo npm test` 在 pi 原版同样命中——保真优先。
3. **遥测为本插件新增**（pi 无此机制）：动机是 stdout 日志随重启蒸发
   （session-dfabc 取证教训），详见 spec §11。

## 已知边界

- OCC 计量 `cacheWriteReadRatio` 是配置假设，未实测坐实（上游提案见
  `docs/upstream-proposals.md`）。
- 多并发 session 状态隔离仅做过双 session 粗验。
- AF 的 replaceAll/edit-only 自然触发路径未验证。
