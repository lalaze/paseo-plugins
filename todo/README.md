# paseo-todo

Sidebar queue for tasks that each run in their own git worktree. A person has to press **Accept and merge** before the result lands on the chosen target branch. Closing the sidebar does not stop the queue.

The page is a board modelled on [codeg](https://github.com/xintaofei/codeg)'s To-dos: **To do**, **In progress**, **Needs you** and **Done** columns, a card per task with one next action (Start, Review, Retry, Open session), a detail sheet with the prompt, the review panel, git details and the diff, and a **New task** dialog that can add a task or add and start it. **Start** runs that one draft; **Start all** queues every draft shown.

The sidebar page gathers tasks from every connected host that has this plugin installed: each card shows its machine and project, **All machines** narrows the board to one host, actions and **Open session** go to the task's own host, and **New task** asks which machine to run on. Each host keeps its own queue, worktrees and data directory; nothing is copied between machines. A host appears once its copy of the plugin is updated to this version.

Inside a workspace, the **Tasks** panel sits next to Files and Changes in the explorer (or run **Tasks for this project** from the command center). It shows the same columns stacked, only for that project, and adds new tasks to the project root. The sidebar page still shows every repository. Plugin ID: `paseo-todo`. It needs a Paseo daemon from 0.10 up to, but not including, 0.12.

`install-all.sh` does not install this plugin. Add it on its own:

```bash
paseo plugin add lalaze/paseo-plugins --path todo
```

From a local checkout, `cd todo && npm ci && npm run build` typechecks and writes `dist/`. The daemon loads the built plugin; this package does not restart it.

The queue connects with `PASEO_TODO_URL` and `PASEO_TODO_PASSWORD` when those are set, otherwise the daemon address and password in `~/.paseo/config.json`. Tasks and the single-process lock live in `PASEO_TODO_DATA_DIR` or `$PASEO_HOME/paseo-todo` (default `~/.paseo/paseo-todo`).

## Limits

- No dependency graph. Nothing is pushed.
- After a merge the task cleans up after itself, in order: it archives the task's sessions and the workspace opened on its worktree, removes the worktree with `git worktree remove` (no `--force`, so an uncommitted or untracked file stops it; ignored files such as `node_modules` go with the worktree), then deletes the `paseo-todo/…` branch only if its tip is the accepted commit, that commit is in the target branch, and no worktree has it checked out. A failed step is shown on the task with a **Retry cleanup** button; the merge itself stands. Your own checkout's branch is never switched.
- The plugin will not merge because a turn ended, a permission was resolved, or the agent said it was done. An agent that can run a shell can still run git itself.
- Accept sends the review binding shown on that screen. A stale page is rejected and does not replace the saved binding.
- A new turn on the producing session invalidates the binding even before files change. Accept is refused while that session is running, waiting for permission, or cannot be inspected.
- Each operation gets a new agent. An older completion cannot capture the next round.
- Cancel leaves the task in `canceling` and keeps the repository queue blocked when the plugin cannot prove the agent has stopped. An inspect failure is not treated as stopped.
- Shutdown waits for an in-flight prepare, capture, merge, or state write before releasing the data directory. It does not start another task after that.
- The data directory lock is the `state.lock` directory. An empty file, unreadable owner record, or dead pid is left in place; delete it by hand only when no paseo-todo process is using the directory.
- A dirty target worktree, a merge already in progress, or a conflict stops the merge. The task branch is kept. The plugin does not `reset`, `clean`, or `merge --abort`.
- Two git processes can still race around the final ref update. The plugin checks the ref again and records a failure instead of rolling a user commit backward.
- If the daemon cannot be reached, sessions are treated as unknown, not stopped: accept is refused, a cancel stays pending, and recovery leaves the task as it was. The plugin reconnects on the next call.
- A task sent back for changes runs in a new session that gets the original prompt plus the requested change, in the same worktree.
- Restart never resends a saved operation. If success cannot be proven, the task stays needs-check or failed.
