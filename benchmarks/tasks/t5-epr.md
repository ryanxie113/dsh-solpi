项目位于 /tmp/bench-t4（已存在，勿重建，勿修改 test 文件和其他模块）。

任务：只修复 src/vector.ts 和 src/matrix.ts 两个模块。对每个模块严格执行：
1. 运行 `node --experimental-strip-types --test test/vector.test.ts`（matrix 同理）查看完整失败输出
2. 根据失败详情修复 src 对应文件
3. 复跑同一命令确认 pass 3 / fail 0 后进入下一个模块
最后运行 `node --experimental-strip-types --test test/vector.test.ts test/matrix.test.ts` 确认两模块全绿并报告。
