# probe-solpi — Phase B 探针包

验证 dsh @ `c291e7961a515f6d7af9304e7fd1d257929aef26` 的结果拦截链与压缩 seam。
Phase C 移植开工后本包可整体删除。结论已沉淀至
`docs/plans/dsh-solpi-spec.md` §8 与 `docs/phase-a-notes.md`。

## 文件

- `src/index.ts` — P1+P2+P3：注册 `solpi_probe_echo` 工具 + `tools/post-execute`
  prepend 监听器（归档→追加两行探针标记）。
- `src/compaction-probe.ts` — P6：类形态 CompactionEngine 子类接管 'compaction'
  服务槽 + 自带 agent/pre-step 触发接线。
- `cordis.dev.yml` — 组合 overlay：qwen-proxy 路由（llm-pi-ai hand-declared 网关）、
  默认模型覆盖、compaction-basic disable、两个探针插件 insert。

## 重跑

前置：dsh checkout 已 `pnpm install && pnpm run build`；qwen-proxy 可达；
锚点路径 `<DSH_INSTALL_ROOT>` 存在（两个源文件顶部常量）。

```sh
cd <REPO_ROOT>
SOLPI_QWEN_PROXY_DUMMY_KEY=none DSH_HOME=$PWD/.dsh-probe \
  pnpm --dir ~/tools/deepseek-harness dsh --profile headless \
  --patch $PWD/packages/probe-solpi/cordis.dev.yml \
  "Call the solpi_probe_echo tool exactly once with name set to Ada. ..."
```

通过判据（与 spec §8 表一致）：

1. 启动出现四行 `[solpi-probe] ...`（P1）。
2. 最终回答逐字含 `[solpi-probe] post-execute intercepted ...` 与
   `[solpi-probe] full copy archived: <locator>` 两行（P2a/P3 提示词可见性）。
3. locator 指向的 spill 工件为无标记 pristine 原文，0600 权限（P3）。
4. 会话日志 `tool/result` 事件文本 = 原文+标记（P2c，Model-visible ⟺ logged）。
5. 出现 `[solpi-probe-compaction] compactIfNeeded trigger=pressure` ≥ 每个 step 一条（P6）。

## 设计要点（移植时可复用的坑位知识）

- out-of-tree 插件的运行时依赖用 `createRequire('<dsh 内包 package.json>')` 解析；
  ESM parent-walk 够不到 dsh 安装闭包，裸导入会炸。
- 服务提供 = 类形态 default export extends 抽象基类；`ctx.set(name, instance)`
  与构造自绑定冲突，勿用。
- 触发接线（pre-step/request-error → compactIfNeeded）是压缩**提供方**的职责，
  需从 BasicCompactionEngine 同构拷贝模式而非继承获得。
