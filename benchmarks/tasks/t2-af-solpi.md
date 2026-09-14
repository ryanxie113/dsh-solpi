在 /tmp/bench-t2 目录搭建并修复一个 TypeScript 多模块项目（目录已存在则清空重建）：

1. 写 package.json：name 为 bench-t2，type 为 module，test 脚本为 "node --experimental-strip-types --test"
2. 写四个模块 src/ 下：calc.ts（add/sub/mul/div，其中 div 有 bug：除数为 0 时应抛 Error 而不是返回 NaN）、
   strkit.ts（capitalize/slugify/truncate，其中 capitalize 有 bug：应只首字母大写其余小写）、
   listx.ts（chunk/unique/flatten，其中 unique 有 bug：未去重）、
   cachex.ts（class LRU，constructor(capacity)，get/set，其中 set 超容量时应淘汰最旧 key）
3. 写 test/calc.test.ts 等 4 个测试文件，每个模块 3 个用例（含一个针对上述 bug 场景的用例），共 12 个
4. 运行 npm test，根据失败详情修复 4 个 src 实现中的 bug（不许改 test）
5. 最后再次 npm test 直到全部通过（pass 12），报告最终结果

硬性要求：每一次 edit/write 修改文件的调用，都必须使用该工具的 thenRun 参数把后续的验证命令
（如 npx vitest run / node --experimental-strip-types --test）直接串联在同一次调用里完成，
禁止"先改文件、再单独发命令跑测试"的两步式操作；所有命令输出完整保留供分析。
