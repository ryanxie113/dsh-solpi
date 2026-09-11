# dsh-solpi

把 [SoL-Pi](https://github.com/NVlabs/SoL-Pi) 在 pi 上验证过的四个效率机制移植到 DeepSeek Harness (dsh) 的插件包。

- **机制清单**：Action Fusion · ObservationPack · Evidence-Preserving Reducer · Online Context Compact（各带独立配置开关，默认全关）
- **目标内核**：dsh 锁定 `c291e7961a515f6d7af9304e7fd1d257929aef26`（developer preview，升级需重跑全部验收）
- **参考实现**：`~/tools/solpi-ext` @ `74f6f97b`（MIT，NVlabs 原作）
- **项目管理**：见 llm-wiki `wiki/projects/dsh-solpi-port.md`（阶段清单 Phase A–E、验收协议、进展记录）

## 验收协议（照搬 SoL-Pi 方法论）

- 训练/隔离 held-out 双 split；终审失败候选不回流为反馈
- 能力地板：能力指标全部 ≥ 预申报容差 ∧ 至少一项效率指标提升
- all-enabled 组合校验脚本（对应 `check-sol-pi-config.mjs --require-all-enabled`）

## 快速开始

```bash
# 探针环境（无需构建 dsh monorepo）
npx @deepseek-ai/dsh web

# 插件装载（Phase C 起使用）
dsh plugin install ./packages/solpi-dsh
```

## License

MIT。SoL-Pi 上游代码若被引用，保留其版权与署名（THIRD_PARTY_NOTICES 待补）。
