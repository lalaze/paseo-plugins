# AI 协作：原生主对话与子 Agent

在 Paseo 正常聊天界面里提出需求、讨论方案和追加修改。主 Agent 通过 MCP 管理任务；后台按保存的分工串行派发子 Agent，统一审核后等待你验收。插件保留协作设置，不再提供独立的任务仪表盘。

## 使用

1. 从命令中心打开「协作设置」，配置执行者和审核者。原地接管沿用当前对话的模型、权限和历史；设置中的主 Agent 模型用于另外新建的协作对话。新建主对话需要 HTTP MCP；原地接管通过当前 Agent 的终端工具调用本机协作接口。
2. 在当前已有对话发送 `/director`，或从命令中心选择「在当前对话启用协作」。当前对话直接担任主 Agent，不创建或切换标签。`/director 任务描述` 同时把需求交给当前对话；重复启用仍绑定同一会话。正在回复时，会等待本轮结束再发送接管消息。
3. 在原生输入框正常交流。只有明确启动实施任务后才创建成果分支；空白对话和普通问答不修改仓库。
4. 通过 Paseo 原生的 `subagent` 入口查看和打开关联子会话；插件不再添加重复的胶囊或列表。暂停、继续、停止协作请在主对话中提出；工作区顶栏不再显示协作设置齿轮，可从命令中心或设置页打开「协作设置」。
5. 开启总纲批准时，阅读方案后单独回复 **批准方案**。最终审核后单独回复 **验收通过**；不采纳可回复 **不采纳成果**。引用文本、模糊的“好”和 AI 自述不会替你验收。

运行期间可以询问进度。需求变化由主 Agent 调用工具，先暂停派发、停止并核对当前步骤，再保存新要求。原生停止按钮只停止当前聊天轮次；停止整个协作请明确告知主 Agent。

子会话出错或丢失后，明确要求重试会按任务保存的原模型及配置建立替代会话，再发送当前步骤。旧操作记录和工作区成果保留，替代会话会先核对已有成果再继续。仍在执行或等待权限的会话不能重复派发；主聊天会话不可用时，需先恢复原主对话再重试。重试仍受本轮调用次数和时间预算限制。

当前工作区启动时保留已有暂存、未暂存和未跟踪文件，成果审核覆盖启动时 HEAD 之后的整体差异。同一目录只允许一个未结束任务。不会自动提交、推送、合并或部署。

首次未配置时会打开协作设置，并保留当前会话和命令中的目标，保存后继续接管。若主 Agent 没有成功调用协作工具，可在主对话询问状态并检查工具调用错误；原生子会话数量不代表后台任务已启动。连接错误保留状态，可点击“重新同步到主对话”。

尚未发过消息的「新建 Agent」草稿没有可接管的会话；先正常发送一条消息，再使用 `/director`。需要独立的新主对话时，仍可在工作区命令中心选择「新建协作对话」。已手动关闭的会话可从工作区历史重新打开。

原地接管需要当前 Agent 能执行本机 Node.js 命令并读写系统临时目录。Paseo 0.8 不支持给已有会话热添加 MCP；插件生成会话专属的命令桥接，通过本机文件队列调用与 MCP 共用的工具处理器，无需为当前 Agent 开放网络权限。桥接脚本与临时请求仅当前系统用户可读（目录权限 700、文件 600）；凭据不写入项目、聊天或命令行参数。工具连接失败会显示错误，不会另建主对话。原地接管的会话丢失时，需要恢复原对话，不自动创建替代会话。

## 旧任务迁移

更新后为旧任务创建新的原生主对话，承接原目标、方案、进度、审核及待确认事项；原会话保留历史，并增加新主对话的迁移说明。不复制或伪造原聊天记录。

迁移准备期间暂停新的后台派发，已创建的操作继续绑定原会话和协议，不重复执行。后续设计使用新主 Agent，新建执行和审核会话关联新主 Agent；旧子会话仍可从原工作区的会话历史访问，不强制修改原父子关系，也不一定计入新主对话的原生子会话数量。完成或取消的任务保持原状态。

设置及未保存草稿保留。新对话使用创建时的设置快照；旧任务迁移使用保存的主模型承接聊天，原执行分工及成果校验继续保留。迁移失败会保留可重试状态。

开发与验证说明见 [NATIVE_CHAT.md](./NATIVE_CHAT.md)。

## 安装、更新与卸载

本插件位于多插件仓库 [`lalaze/paseo-plugins`](https://github.com/lalaze/paseo-plugins) 的 [`director/`](.) 目录。安装到另一台主机的完整步骤见 [INSTALL.md](./INSTALL.md)。如果只是换电脑连接同一个 Paseo daemon，无需重复安装。

需要 **Paseo daemon 和 app 0.8.x / 0.9.x（含 beta）**、**Node.js 22.13+**、Git，以及至少一个已登录并可用的 Paseo AI provider。此次实现基于本机 Paseo **0.8.0** 校验。插件 ID 为 `paseo-director`。

### 安装

在目标主机的 Paseo **Settings → Plugins** 开启插件，并确保运行 daemon 的用户有本仓库的 GitHub SSH 读取权限，然后执行：

```bash
paseo plugin add lalaze/paseo-plugins --path director
paseo plugin ls paseo-director --json
```

SSH 源：

```bash
paseo plugin install git@github.com:lalaze/paseo-plugins.git:director --ref main
```

`--path director` 或 `:director` 指定本多插件仓库中的插件子目录。安装会自动运行锁定依赖的 `npm ci --include=dev --ignore-scripts` 和类型检查，再由 Paseo 编译加载。确认状态为 `running` 后，在已有工作区发送 `/director`，打开 **协作设置** 保存 AI 分工。

### 更新

GitHub 源安装：

```bash
paseo plugin update paseo-director
paseo plugin ls paseo-director --json
```

更新会获取 `main` 的新提交并重新加载插件，无需重启整个 daemon。GitHub 同步的是插件代码，AI 登录信息、团队配置和任务记录保留在各自主机。建议在没有进行中的协作任务时更新。

本地目录安装不能使用 `paseo plugin update`。覆盖源码后：

```bash
npm ci --include=dev --ignore-scripts
npm run check
paseo plugin reload paseo-director
paseo plugin ls paseo-director --json
```

如果之前通过本地目录或旧仓库 `paseo-sub-agnet` 安装，请先卸载再从本仓库安装：

```bash
paseo plugin remove paseo-director
paseo plugin add lalaze/paseo-plugins --path director
```

完整切换步骤见 [INSTALL.md](./INSTALL.md#从目录安装切换到-github)。

### 卸载

```bash
paseo plugin remove paseo-director
```

Paseo 0.8.0 的移除操作不会删除 AI 协作数据目录、源码目录或工作区代码。同一 daemon 重新安装后，会继续使用 `$PASEO_HOME/director`（或 `PASEO_DIRECTOR_DATA_DIR`）里已保存的团队配置和任务记录。

安装、更新或重载失败时查看：

```bash
paseo plugin logs paseo-director
```

### 本地目录开发

如果已经克隆仓库，在 `director` 目录运行：

```bash
npm ci --include=dev --ignore-scripts
npm run check
paseo plugin install "$PWD"
paseo plugin ls paseo-director --json
```

原生插件需要主机已启用 Paseo 插件功能。插件在该主机执行本地代码。开发修改后执行上面的 `reload` 命令。

`paseo plugin install` 会记录目录路径。移动本仓库后，需要重新安装从该路径装过的插件。`npm run build` 优先使用已安装 Paseo CLI 中的官方编译器，验证宿主前后端边界并输出 `dist/`。没有 CLI 编译器时使用 esbuild，正式安装时再由 Paseo 校验。可通过 `PASEO_COMPILER` 指定官方 `compiler.js` 路径。

本机安装后的只读冒烟检查：

```bash
node --import tsx scripts/smoke.mjs
```

该检查只读取插件状态、RPC 和 provider 目录，不创建 AI 会话。

## 运行文件

默认目录为 `$PASEO_HOME/director`，未设置 `PASEO_HOME` 时使用 `~/.paseo/director`：

```text
director/
  director.sqlite          # 角色配置、任务、步骤和检查点
  worktrees/<run-id>/       # 独立工作区模式的任务代码；同工作区模式使用原目录
  artifacts/<run-id>/       # 固定版本的 diff 和原始检查日志
```

SQLite 中包含 MCP 访问令牌，不应提交或分享数据库。界面与运行 RPC 不返回令牌。MCP 只监听本机回环地址，随机选择的端口会持久化并在重载时复用。

可选环境变量，设置在 **Paseo daemon 的启动环境**中：

| 变量 | 用途 |
| --- | --- |
| `PASEO_DIRECTOR_DATA_DIR` | 覆盖 AI 协作数据目录 |
| `PASEO_DIRECTOR_URL` | 覆盖本机 daemon WebSocket 地址 |
| `PASEO_DIRECTOR_PASSWORD` | 覆盖连接密码；否则使用 `PASEO_PASSWORD` 或 daemon 配置 |
| `PASEO_DIRECTOR_MCP_PORT` | 指定本机 MCP 端口 |

默认连接读取 daemon 的 `PASEO_HOME/config.json` 中 `daemon.listen`。非标准监听环境需设置 `PASEO_DIRECTOR_URL`；插件不会改写 daemon 配置。同一数据目录只允许一个 AI 协作后台实例。

## 实现与验证说明

任务状态机在 `server/engine.ts`，聊天协调在 `server/conversations.ts`，宿主接入集中在 `server/paseo.ts`。会话、通知和用户确认都保存在 SQLite 中；重复消息、旧操作结果和过期成果不能重复推进任务。

运行 `npm run check` 完成类型检查、回归测试与官方插件编译。测试通过 `tests/locale.mjs` 固定为英文界面文案，不受系统语言影响。HTTP MCP 集成测试需要本机回环端口权限。实际宿主验证应使用独立的 `PASEO_HOME`、`PASEO_DIRECTOR_DATA_DIR` 和 `PASEO_DIRECTOR_URL`，避免将测试连接到已有协作数据。

## 子任务通知静默

子 Agent 完成、主对话的后台中间进度汇报不弹系统推送或应用内通知。方案待批准、最终验收／整体完成、需要处理的错误和权限请求保留提醒；聊天记录与任务状态照常更新，普通对话回复也保留原通知行为。

Paseo 0.8 插件接口无法控制宿主推送，需要在 daemon 所在主机安装小范围通知补丁：

```bash
node director/scripts/notification-patch.mjs check
node director/scripts/notification-patch.mjs apply
```

命令从本仓库根目录执行。补丁需重启 daemon 后生效；有正在执行的任务时，等其结束再重启。使用本仓库的 `agy-quota/bin/paseo` 入口启动或重启时，会自动检查并补上规则。仅重载 Director 插件不会重载宿主通知代码。

撤销：`node director/scripts/notification-patch.mjs rollback`，随后重启 daemon。补丁支持 Paseo 0.8.x / 0.9.x（含 beta），识别官方 CLI 和 `@lalaze/paseo-cli`；遇到未适配的上游代码变化会拒绝改写。0.9 的通知订阅筛选保持不变。静默规则只作用于 Director 标记的会话，并且仅抑制通知投递，保留原有未读状态和事件。

### 顶栏按钮顺序

此补丁兼容仍显示「协作设置」齿轮的旧版插件，让本机网页顶栏的「额度速览」排在齿轮前，不受两个插件加载先后影响。当前版本已隐藏齿轮。使用本仓库的 `agy-quota/bin/paseo` 启动或重启 daemon 时会自动应用；手动应用后刷新网页：

```bash
node director/scripts/header-order-patch.mjs check
node director/scripts/header-order-patch.mjs apply
```

撤销：`node director/scripts/header-order-patch.mjs rollback`，随后刷新网页；守卫下次启动会重新应用。补丁支持 Paseo 0.8.x / 0.9.x 的网页资源，发现宿主代码不匹配时拒绝改写；原生客户端不受影响。
