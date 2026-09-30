# paseo-todo 设计

独立插件 `todo/`，id `paseo-todo`。侧栏「待办任务」只负责创建和验收。执行在插件服务进程里，关掉前端不会停队列。不读取、不迁移、不复用已归档的 `director/` 数据或调度器。

## 状态

`draft` 草稿 → `queued` 排队 → `preparing` 准备（已写入 operation id）→ `running` 执行中。

权限请求只把 `running` 改成 `needs_attention`（待权限）。`permission_resolved` 回到 `running`。这两种都不是完成。

只有 `agent.turn_ended` 的 `outcome.kind` 能结束一轮：

- `completed` → 在任务分支上固化提交后进入 `awaiting_review`（待验收）
- `failed` → `failed`
- `canceled` → `canceled`

权限按请求 id 记账：同一会话还有未处理的请求时，处理掉其中一个不会回到 `running`。

没有 `idle` 这条路径。服务重启后，`canceling` 的任务重新发出取消并按取消收尾，不会因为会话仍在跑而退回 `running`。其余执行中的任务若没有已保存的 outcome，且会话已不在跑、也没有待处理权限，进入 `needs_check`（待核对），不重新发送。会话仍在跑则只继续等待下一次 `turn_ended`。

`canceling` 期间忽略成功结果，最终记为 `canceled`。`merging` 与取消互斥：合并锁持有时取消直接拒绝。

同一仓库一次只执行一个任务。准备工作树、固化成果和合并这几步 git 写操作另有一把短锁串行，合并不必等同仓库另一个任务的整轮执行结束。锁的顺序固定为先任务锁、后 git 锁。待验收不占用执行名额。不同仓库可以并行。

继续修改或重试会分配新的 operation id、清掉旧的验收绑定，并新建一个 Agent。继续修改时新会话收到的是原任务内容加上打回意见，工作树沿用上一轮。旧会话上的 `turn_ended` 不能推进新一轮。事件缓存按 agent 与 turn 记录，处理过后即删除；重复回调和已经对不上当前 `turn_started` 的回调不再固化成果。排队且还没有 operation id 的任务才允许派发。

`agent.turn_started` 若落在已有验收绑定的会话上，立刻把任务改为待核对并清掉绑定，即使工作树还没改。验收前再检查该会话：仍在执行、仍有待处理权限，或检查本身失败，都不进入合并，也不改已保存的绑定。

取消在创建会话之前和之后都要收尾。只有确认没有会话，或检查明确显示会话已停止且没有待处理权限，才写成已取消并放开该仓库。检查失败保持 `canceling`，仓库继续被占用。插件关闭时先停止新的派发，等已经开始的准备、固化、合并和写盘结束后才释放数据目录锁；关闭之后的回调不再写盘。

## 验收绑定

进入待验收时记下：成果 commit、成果 tree、目标分支、当时的目标分支 HEAD、本轮 `turnId`。

「验收并合并」的请求体是 `{ id, review }`。`review` 必须是用户当时在页面上看到的那份绑定，服务端与当前存档逐项严格相等，否则返回 `stale-client-review`，不进入合并，也不改写已保存的新绑定。这样旧页面不能只凭任务 id 批准后来的新版本。Git 与存档是否仍一致是通过这道比较之后的另一次检查。

固化成果和合并前都确认任务目录的 git common-dir 属于该仓库，且当前分支就是任务分支。对不上就停止，不对错误分支 `git add` 或 `commit`。目标或任务工作树若已有 merge、rebase、cherry-pick、revert，直接拒绝。ff-only 失败时不执行 `merge --abort`。

`state.lock` 是一个独占创建的目录，目录存在即表示锁被持有。空文件、无效内容、尚未写完的 owner 记录或已退出进程的 pid 都不会被删掉来抢锁。只有创建这把锁的进程在 `dispose` 时移除它。拿不到锁的进程不调度。状态变更先串行写入 `state.json`，成功后才发布到内存；写失败时后续调度仍看见上一份已落盘的任务。

以下任一情况都使绑定失效，状态改为待核对，合并函数不会被调用：

- 任务分支 HEAD 或 tree 变化，或工作树变脏（包括用户打开同一会话后又改了文件）
- 目标分支 HEAD 变化
- 同一会话出现新的 `turn_started`，或另一个 `turnId` 的 `turn_ended`

聊天文本和 Agent 自述不参与状态判断。插件不向 Agent 提供合并工具。`prepareMerge` / `applyMerge` 只由「验收并合并」RPC 在任务锁内调用。

## 合并

1. 再次核对绑定、任务工作树干净、目标 HEAD 未变。
2. `git merge-tree --write-tree <目标HEAD> <成果commit>`。退出码非 0 视为冲突：不创建引用，不进入任何用户工作树，任务分支保留。
3. 仅在预计算干净时 `git commit-tree` 写出合并提交（父提交依次是目标 HEAD、成果 commit）。先把这个 sha 记入 `pendingMergeCommit`。
4. 目标分支已在某个工作树检出：该工作树必须干净且 HEAD 仍是绑定的目标 HEAD，然后在该目录执行 `git merge --ff-only <预计算提交>`。脏工作树直接拒绝。
5. 目标分支未检出：`git update-ref refs/heads/<分支> <新> <旧>`，旧值必须等于绑定的目标 HEAD。
6. 引用更新后再读一次 HEAD。对不上则记 `merge-verify`，不 `reset`、不覆盖。
7. 不 push。

预计算或更新引用时 git 抛出异常，任务也不会停在 `merging`：按目标引用收尾，已等于预计算提交记为已合并，仍是绑定的 HEAD 记为合并失败（绑定保留，可再次验收），其他情况或读不到引用都进入待核对。

验收页面上的 diff 以目标 HEAD 与成果提交的 merge-base 为起点（`a...b`），目标分支在任务开始后新增的提交不会显示成被任务删除。

外部 Git 进程与这次更新之间没有绝对隔离。紧挨着更新再做一次校验；失败时不回滚用户已经前进的提交。重启时若目标引用已经等于 `pendingMergeCommit`，记为已合并；若目标 HEAD 还是绑定值，退回待验收，不自动再合并。

## 连接

插件在首次使用时连接 daemon，失败后下一次调用会重连。连不上时所有会话操作都返回 `gateway-unavailable`，不会把查不到的会话当成已停止：验收拒绝合并，取消保持 `canceling`，重启恢复只记下错误、不改状态。

## 持久化

`PASEO_TODO_DATA_DIR` 或 `$PASEO_HOME/paseo-todo`（默认 `~/.paseo/paseo-todo`）。`state.json` 用 zod strict 校验，临时文件改名写盘。损坏的文件不覆盖。工作树在该目录的 `worktrees/` 下，首版不自动删除。

## 不做

依赖图、自动清理工作树、自动推送、以及阻止有 shell 权限的 Agent 自己执行 Git。插件自己的代码路径不会因为轮次结束、权限回调或聊天内容去合并或推送。
