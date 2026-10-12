# Paseo 原生授权接入验收（2026-10-12）

用户需要在 Paseo 看见并确认 Dot 的授权请求。已接入原生 provider permission 协议与 Dot tasks 详情按钮，新增 `request_dot_permission`、`report_dot_permission_blocked` 两个 MCP 工具，没有远端批准工具。

请求和决定持久化到 v9 状态。允许或拒绝会原子写入带范围的用户消息及唤醒事件。停止、新输入或轮次结束后，旧 pending 请求失效；重复决定幂等，冲突决定拒绝。当前 pending、denied、platform-blocked 请求禁止 Bridge 写文件和上传；当前批准仅覆盖指定工具及文件路径/附件名，不代表其他工具也获授权。

Paseo 的授权不能替代 ChatGPT 平台审批。平台仍拒绝时，Dot 报告实际原因，Paseo 显示等待状态及 Your dot 入口。用户在那里完成具体确认后回到原会话；不得伪造平台接受。如果回报工具本身被平台取消，Bridge 无法获知未送达的失败，Dot 必须在主页如实说明。

## 自动验证与部署

- `npm run check`：195 项测试全部通过、TypeScript 与构建通过。
- 新增 9 项权限测试：原生事件、允许/拒绝、重复及冲突点击、范围篡改、跨会话请求、停止和新输入失效、附件工具与目标约束、重启持久化、v8 原始字节备份迁移、MCP 认证与拒绝远端伪造批准、平台阻塞提示。
- `paseo plugin reload paseo-dot-bridge` 后插件 running；实际状态版本为 v9，旧状态备份保留。
- ChatGPT 已 Refresh tools；界面中两个新工具可见（Write 9 / Read 6）。未改变插件的 Allow low-risk 平台权限设置。
- 原始 Your dot 事件规则「验证 Paseo Bridge 连接」已保存并回读核验新授权处理要求；原停止确认要求及两个事件触发器保留。规则持续保存，不依赖 /tmp。

原始规则已通过界面保存并回读核验。截图含私人聊天背景，仅在本地保留，不纳入仓库。

## 实际验收

纯文字合成会话 `a0ac4c3c-4dba-4df4-b7af-49796ff235a2`，任务 `0bcca5db-837d-4605-b4b4-6d7c39b8a667`。仅请求发送固定测试标记；没有文件读取、写入、上传或真实业务动作。Dot 按正常事件自动领取并自行调用请求工具；外部未代为领取或提交结果。

第一轮 `a5bea48c-45e2-400c-a9d3-561c11b07643`：

- 10:38:25.047 UTC 创建任务；10:39:12.875 自动领取。
- 10:39:48.943 Dot 发起请求 `9724497b-84e6-4f6c-a901-f51a17db1c02`；`paseo permit ls` 实际列出原生权限及准确范围。
- 10:40:12.750 用 Paseo 原生权限命令允许此合成动作。
- 10:41:09.279 Dot 自动回传 `PERMISSION-ALLOW-OK`，状态 completed、processedThroughSeq=4、coversLatest=true。本地决定到结果约 56.5 秒。

浏览器访问本机 Paseo 被客户端拦截，因此本次真实流程通过 Paseo 原生权限命令验证；未声称完成手机/桌面卡片视觉验收。任务详情 UI 已通过类型检查和打包。平台阻塞分支使用隔离集成测试验证，未人为触发真实平台安全拒绝。

初版验收拟读取本地 README 首行，被自动审批拒绝（未明确授权该内容传出）。已改为上述纯固定文字方案，未执行被拒绝动作。

第二轮连续追问 `1f78bd6a-23d0-4cbf-9f4b-4f153ad6ee27`：Dot 自动新建请求 `1618cb18-59c9-42f1-b00f-9b12609eb8e7`，没有复用上轮授权。Paseo 原生拒绝后约 118.1 秒自动回传 `PERMISSION-DENIED-OK`；completed、coversLatest=true，未重复请求。两轮原始时间和结果见 [精简实机证据](permission-live-evidence.json)。

## 提交前配套检查

配套 usage-glance 接入通过 TypeScript、116 项测试以及当前已安装 Paseo 编译器的构建/导入边界检查；`scripts/check-consumption.mjs` 的 Android、iOS、Web 组件渲染和服务端 RPC 检查通过（不是设备实测）。修正了旧测试假设 translate 永远是来源列表最后一项的问题。此机器使用自定义安装的 Paseo，构建通过现有 `PASEO_COMPILER` 环境变量指定当前安装的编译器；默认 npm 全局 CLI 路径在本机不可用。
