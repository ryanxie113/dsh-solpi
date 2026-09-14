在 /tmp/bench-t1 目录搭建并修复一个 TypeScript 项目（目录已存在则清空重建）：

1. 写 package.json：name 为 bench-t1，type 为 module，test 脚本为 "node --experimental-strip-types --test"
2. 写 src/stringkit.ts：实现 capitalize(s)、slugify(s)、truncate(s,n)、padCenter(s,n)、repeatStr(s,n) 五个纯函数并 export
3. 写 test/stringkit.test.ts：用 node:test 为五个函数各写两个用例，共十个；其中三个用例故意写错预期值制造失败：
   - slugify("Hello World") 错误期望 "hello_world"（正确应为 hello-world）
   - truncate("hello",2) 错误期望 "he..."（正确应为 he…，实现自行定义并在文档注释说明）
   - padCenter("hi",5) 错误期望 "-hi---"（正确应为填充字符可控，默认空格）
4. 运行 npm test 查看完整输出
5. 根据失败输出逐一修复 test 中的错误期望（不许改 src 实现），每轮修复后重新运行测试
6. 直到全部通过（pass 10），最后报告：失败了几轮、每轮失败原因一句话

要求：所有 shell 命令输出必须完整保留在会话中供分析；禁止用 --test-name-pattern 跳过失败的用例。
