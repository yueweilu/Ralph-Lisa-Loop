# A05：自动提交返回忙、丢失响应与写入崩溃

日期：2026-11-10。基线为 `feat/herdr-auto-task-launch` 的 `b4f738fa50e52f6968070cdf2d88f17afbb50563`。按[实施方案](herdr-auto-task-launch-implementation-2026-11-06.md) A05 验收。仅新增测试及记录，没有修改提交门禁或恢复策略。

## 验证方法

在 `integrations/herdr/managed-shutdown.test.mjs` 的隔离项目中运行真实 RLL CLI 与协调器，以假 Herdr/Agent 固定两席位置和提示回执。只在协调器调用 `host commit` 的边界注入三种返回；候选先由真实 CLI 提议，当前项目与会话持有正式自动授权。每种情况保存协调器的自动提交请求 ID，回读同一 ID 的宿主回执、generation、投递文件及提示次数，确认没有凭错误码自行生成第二个请求。

| 注入点 | 现场断言 |
|---|---|
| `host commit` 返回 `HOST_BUSY`，不执行写入 | 协调器只读查询同一请求 ID，结果为 `unknown`；进入 `needs_reconcile`。generation 0、无提交回执、无交接投递、只有初始提示；正式提交调用一次。 |
| 真实 CLI 已提交并持久化回执，但调用包装器丢弃 stdout 并以失败状态退出 | 协调器只读查询同一请求 ID，取得 `committed`，继续一次 Ralph→Lisa 投递。generation 1、回执标记 `session_authorized_auto`、一份交接投递、总提示两次；正式提交调用一次。 |
| 调用无有效响应，也不执行写入 | 同一 ID 的回执为 `unknown`；协调器进入 `needs_reconcile`，generation 0、无交接；正式提交调用一次。 |

已有 `cli/src/test/host-write-fault-matrix.test.ts` 使用真实写入器在 Ralph 和 Lisa 两席的意图、业务文件、代次、回执与归档边界执行进程崩溃矩阵。该矩阵使用人工确认候选，验证的是自动与人工模式共用的宿主写入器，不替代上面的自动授权边界测试。崩溃后先显式处理陈旧命令锁，再只读查询；未完成的状态返回 `NEEDS_RECONCILE`，只有持久回执能作为同一请求 ID 的已提交结果。另有 Lisa 短锁竞争用例，验证锁释放后只提交一次，持续占用时返回 `HOST_BUSY` 且无回执。

## 结果和边界

- `node --test --test-name-pattern='auto commit' integrations/herdr/managed-shutdown.test.mjs`：3/3 通过。
- `node --test integrations/herdr/*.test.mjs`：60/60 通过。
- `node --test cli/dist/test/host-write-fault-matrix.test.js`：4/4 通过。

以上是**本地隔离故障注入**，不是实际 Herdr Server 在提交瞬间断线的现场验收。它证明当前协调器在明确回执时能够接续一次交接，在回执不明时保留阻断；未证明所有操作系统断电或文件系统故障形态。真实 Server 重启时的自动授权接续仍列为独立 A06 验收。
