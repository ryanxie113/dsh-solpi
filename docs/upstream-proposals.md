# 上游提案草稿（可直接贴 issue）

以下两份提案源自 solpi-dsh 移植过程中的实测痛点（session-dfabc、minissg 长任务），
措辞按 dsh 仓库惯例撰写，提交前请按当时代码核对 API 名。

---

## 提案 1：tokenMeter 暴露缓存读写字节/token 明细

### 背景

dsh 的 `agent.tokenMeter.measure(session)` 目前只返回 `{ totalTokens }`。
任何想做"上下文经济学"决策的扩展（例：solpi-dsh 的 Online Context Compact）
只能拿总 token 数推断压力，无法回答关键问题：

> 这轮请求里，多少 token 是**新写入缓存的**（贵），多少是**缓存命中读取的**（廉）？

### 现状后果

- 缓存经济门槛（cacheWriteReadRatio 类策略）只能是配置假设，无法实测校准。
  我们在移植中将其设为 1.4 并以注释声明"未坐实"。
- 无法区分「重复前缀命中」与「真实新增上下文」，导致压缩时机系统性偏晚或偏早。

### 提案

在 measure 返回值中增加（各 provider 已有原始字段，仅缺透传）：

```ts
interface Measurement {
  totalTokens: number
  cacheReadTokens?: number   // openai-completions: prompt_tokens_details.cached_tokens
  cacheWriteTokens?: number  // anthropic: usage.cache_creation_input_tokens
}
```

可选缺省即可——没有缓存计量的 provider 返回 undefined，不破坏现有调用方。

### 验收

- qwen-proxy/openai-completions 与 anthropic 两类 provider 下，能从一次真实
  请求的 measure 结果读到非零 cache 计量。
- solpi-dsh occ-gate 遥测的 breakeven 决策可用实测比值替换配置假设。

---

## 提案 2：compaction 事件携带 purpose 标签

### 背景

dsh 中多个主体都能触发消息区间压缩：compaction-basic 的自动压缩、扩展主动调用
region 压缩（如 solpi-dsh OCC）、未来可能有手动命令。压缩发生时缺乏统一可观测
标记，导致：

- 会话取证时无法区分「这轮摘要是谁压的、为什么压」；
- 扩展侧统计与内置压缩互相污染（我们曾为定位 27 次"摘要缺席"异常翻遍日志，
  最终因日志随重启蒸发而根因不可考）。

### 提案

压缩产物的边界记录（boundary/marker 或 message metadata）统一附带：

```ts
{ purpose: 'auto' | 'economic' | 'manual', origin?: string }
```

- `origin` 由发起方自报（如 `solpi-dsh-occ`），内置路径可为空；
- compaction-basic 落地边界时透传该标签到持久化状态。

### 验收

- 任一 session 的压缩历史可以从状态/消息流中直接按 purpose 过滤统计；
- 第三方扩展的压缩与内置自动压缩在观测面上可分。

---

## 提案 3：将 region 压缩选择逻辑纳入公开导出面

### 背景

dsh-bundle 形态的第三方插件无法复用 region 级压缩实现：compaction-basic 的
`files` 白名单只含 `lib/index.js` 与类型——**npm 发布包里没有 src/**。其 exports
map 的 `"./src/*"` 仅在 monorepo workspace link 形态下可达。

solpi-dsh 的 Online Context Compact 复用 `src/region.ts` 的 selectCompactableRange /
compactRegion（OCC 决策 A 全保真），在源码检出形态下工作正常；但作为 bundle 经 npm
分发的用户会撞上“文件不存在” fail-fast。

### 提案

二选一（或都做）：

1. compaction-basic 主入口 re-export region 实现：
   `export { selectCompactableRange, compactRegion } from './src/region'`
   （或建立稳定子路径 exports，如 `./compaction-region`）。
2. 在文档中声明 `./src/*` 导出的稳定性承诺范围（哪些子路径第三方可依赖）。

### 验收

- 一个纯 npm 安装的 bundle 型插件能 import 到 region 选择逻辑并驱动一次真实压缩；
- dsh 升级时该面有 semver 承诺。

---

*起草：solpi-dsh 移植项目（`Mywork/code/dsh-solpi`），规格见
`docs/plans/dsh-solpi-spec.md`。*
