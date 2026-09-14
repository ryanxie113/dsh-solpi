# dsh 官方插件形态侦查报告（2026-09-13）

来源：`CONTRIBUTING.md` · `README.md`(§Community) · `docs/user/develop/basic/publish.md`
· `docs/cordis-tutorial/01-first-plugin.md` · `vendor/loader/src/config/tree.ts` ·
`apps/cli/src/profile-boot.ts` · 官方包 package.json 实测。
外部社区案例侦查（github topics/dsh-plugin）两次网络超时未果——以下全部基于本机
dsh 检出（commit c291e79 附近）内部证据。

## 1. 官方生态约定

- **不接受外部 PR**（CONTRIBUTING 明文）。生态路径：
  - **独立 GitHub 仓库 + `dsh-plugin` topic 标签**做发现性；
  - 官方立场：社区包与官方包地位平等（"not a mandate from us"）。
- 已有官方挂名的社区插件范例：**turtle-ui**（github.com/deepseek-harness/turtle-ui），
  其 `prepare` 脚本用独立 tsdown config 转 src、无 project references——可作打包模板。

## 2. 分发形态：**bundle**（npm 包）

权威文档：`docs/user/develop/basic/publish.md`。要点：

```jsonc
// hello-plugin/package.json
{
  "name": "dsh-hello-plugin",
  "type": "module",
  "main": "index.js",
  "files": ["index.js", "cordis.patch.yml"],
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }   // ← 关键声明
}
```

- bundle 的 `cordis.patch.yml` 里 rows **按包名引用**（`name: dsh-hello-plugin`），
  Node 解析自 profile 目录向上找 node_modules——不再需要绝对路径。
- 安装三通道：
  | 通道 | 命令 | 构建要求 |
  |---|---|---|
  | 本地检出 link | `dsh plugin --profile <p> add ./dir` | 无 |
  | GitHub 直装 | `add github:you/pkg[#sha]` | 作者须备自包含 `prepare`；用户须 allowBuilds |
  | npm / tarball | `add <pkg>` / `add ./x.tgz` | 发布时已带 lib，无需构建权限（最顺滑）|
- 层序：bundles(按添加序) → profile patch → `$DSH_HOME/cordis.patch.yml` → `--patch` overlays。
  patch 按 id 整行覆盖、不深合并。
- `dsh plugin --profile <p> list/add/remove/remove` 已实测可用（本版本 CLI 存在该子命令）。

## 3. 对 solpi-dsh 的直接约束

### 🔴 约束 A：compaction-basic 的 src 深引在 npm 形态下断供
`@deepseek-ai/dsh-compaction-basic` 的 `files: ["lib/index.js", "lib/types/**/*.d.ts"]`
——**发布包里没有 src/**。其 exports `"./src/*"` 只在 monorepo workspace link 形态下
有效。我们的 OCC 经 `regionModuleUrl()` 深引 `src/region.ts`：
- monorepo 检出形态 ✅（现役）
- npm 安装形态 ❌（文件不存在 → anchors fail-fast 报错，不静默）
可选出路（需拍板）：
1. **上游提案**：把 region 选择逻辑纳入 lib 公开导出面（推荐，与已有两提案同批提）；
2. 短期标榜"源码检出安装"（GitHub link 形态 compaction-basic 从 dsh 主仓 checkout
   peer 链接时 src 可达）——但纯 npm 安装用户仍会撞墙；
3. 复制 region 逻辑进我们包（违反 pi 保真原则，不推荐）。

### 🟡 约束 B：四机制=一包四入口的子路径导出面
bundle 是一个包；patch rows 需要 `name: '<pkg>/action-fusion'` 类子路径入口 →
package.json exports 需逐模块声明（./action-fusion, ./observation-pack,
./evidence-preserving-reducer, ./online-context-compact）。schemastery Config 导出
约定不变（loader 对 npm 包同样取 unwrapExports.Config）。

### 🟡 约束 C：stock 行覆盖要整行复述
现 overlay 里 `tool-fs/compaction-basic disabled: true` 等覆盖行迁入 bundle patch 时
必须整行复述（层序规则），web preset 重挂问题同理复核。

### ✅ 有利条件
- anchors.ts 双布局探测天然兼容两种形态（npm 下 node_modules 探测命中，
  region 缺失走 fail-fast 明报）；
- 遥测/状态存储按 $DSH_HOME，与安装形态无关；
- CJS 转译兼容已在 boot 验证过（顶层无 await 约束已满足）。

## 4. 包化改造清单（拍板后执行）——✅ 已执行（2026-09-13，路线 1）

1. ✅ `cordis.patch.yml`（bundle 层：4 insert + tool-fs/compaction-basic 整行 disabled 复述）
2. ✅ package.json：`solpi-dsh@0.1.0` / type:module / 子路径 exports（四机制）/ files 白名单 / `dsh.bundle.patch` 声明 / MIT
3. ✅ tsdown 独立配置（devDep tsdown 0.22.2 自包含，参照 turtle-ui 模式）；一次构建通过，产出 lib/*.mjs + 共享 chunk；esbuild cjs transform 验证无 TLA（loader 兼容）
4. ✅ upstream-proposals 增补提案 3：region 选择逻辑纳入公开导出面（解约束 A）
5. ✅ README 增补“安装（bundle 形态）”三通道章节 + region 依赖说明
6. ✅ 实测全链路：`dsh plugin --profile web add <本地包>` → bundles 追加 →
   `--dump-config` 出现 `# == solpi-dsh` 层四行按包名 rows → **bundle 形态 boot 成功**
   （8788 冒烟：四横幅/存储落 .dsh-probe/sol-pi//401 探活，零 --patch overlay）

### 实测坑与教训

- `dsh plugin` 不带 DSH_HOME 时作用于默认 home（~/.dsh/profiles/<name>）——排查时一度看错目标目录；reconcile 逻辑本身无误。
- profile 目录手跑裸 pnpm add 可写 dependencies 但绕过 bundles reconcile，两条路不等价。
- link: 安装下 anchors 的 monorepo walk-up 会失效（realpath 是本仓库非 harness），
  node_modules 探测也命中不了 @deepseek-ai——**SOLPI_DSH_ROOT 成为 link 形态的必要环境变量**（纯 npm 形态下依赖提案 3 落地后的 peer 安装）。


## 5. 实弹验收（2026-09-14，bundle 形态 + 真实长任务）

任务：/tmp/solpi-live node:test 计算器红→绿循环（提示词存 `.live-task-prompt.txt`）。
链路：`dsh --profile headless --patch llm-overlay`（bundle 已挂 headless profile，
**网关必须经 proxyjump HTTP 代理——10.129 段 TCP 层需代理跳转，ICMP 可达不代表端口可达**）。

events.jsonl 实弹：14 事件 = occ-gate×6 / occ-result×2 / af-then-run×4(全 succeeded) / epr-skip×2(below-min-bytes: 1139B/339B<4096B)。

关键验证点全数命中：
- **occ-result.summaryBlocks=1×2** —— "摘要缺席"从此直接可见（session-dfabc 之谜的机制性解答）
- 三方账目闭合：telemetry epoch=2 ↔ OCC state file epoch=2/requestCount=6 ↔ gate 检查次数
- 首轮 gate=non_positive_saving(write=0) 正确拒压；后续 economic 全带 breakeven 实测值
- EPR 新诊断族正则工作正常（node --test 命中），skip 理由精确到字节——顺带解释 minissg 时代零自然触发之谜：小任务测试输出本就低于 minBytes
- 0600 权限/schema 字段/会话 id 关联全部符合设计

遗留观测点：occ-result.totalAfter≈15.6k 而窗口 262k——短任务离压缩门槛远属预期；
epr-applied（≥4KB 诊断输出自然触发）仍待更重的失败堆栈场景。
