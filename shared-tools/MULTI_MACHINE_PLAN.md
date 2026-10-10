# 多机器共享 MCP：中心网关实施计划

## 目标与架构

用户已要求实施：在中心机器完成一次 MCP 授权，其他机器通过中心调用同一账户的 MCP；由主 Codex 制定计划、审核，由 Paseo 的 Codebuddy Code / DeepSeek 执行代码变更。

调用路径：其他机器的 Agent → 带设备凭据的中心网关 → 中心读取本地授权 → 上游 MCP。

中心保留上游 API key、OAuth access/refresh token、原客户端授权引用。远端只获得可撤销的网关凭据，不复制 `oauth.json`、CLI 凭据库或上游 headers/env。一次授权的承诺以授权有效为前提：借用 Codex 等原客户端的授权仍由原客户端刷新，失效后提示在中心重新授权。

第一版完成 HTTP / Streamable HTTP MCP 的端到端共享（包含 HTTP 响应中的 SSE 流）。旧 `type: sse` 传输与本地 `stdio` 不冒充受支持的远程服务；目录与界面解释限制。技能同步、stdio 桥接、旧 SSE endpoint 重写留作后续独立范围。本机现有 MCP 与技能功能保持兼容。

## 1. 中心配置与设备管理

- 网关默认关闭，仅用户开启才监听网络。支持配置监听地址、端口和对外 URL；启用跨机器访问时可绑定 `0.0.0.0`。用户可见的本机默认地址采用 `http://100.96.195.115:<port>`，建议配置端口 47822，避免 OAuth 回调端口。
- 对外地址可由用户修改；普通 HTTP 仅用于 Tailscale/受信私网，公网使用 HTTPS 反代。地址校验拒绝 userinfo、fragment 和含设备 token 的 URL，不拼接泄露 token 的链接。
- 每个设备凭据关联设备名、非空的授权 Provider 列表、允许的服务器列表（null 为全部，空列表为无）。中心验证请求指定的 Provider 位于设备授权列表中，再与该 Provider 的现有 MCP 权限取交集；不同 Provider 的权限不能合并。
- 创建设备时可多选 Provider，并支持全选/清空。已有设备可编辑授权 Provider，保持原令牌；移除某个 Provider 立即停止其活动流并使其会话失效，其余 Provider 不受影响。旧版单 Provider 设备仅在缺少新列表字段时迁移，非法或空列表不能回退扩大授权。
- 用强随机值生成 Bearer token；中心只持久化 hash，创建时仅返回一次原文，设备列表不返回原文/hash。可撤销，重启后保持有效；文件权限 600，原子保存和串行写入。
- 网关设置/设备凭据与现有 config/oauth 数据分开存放，避免修改旧文件格式和跨机文件并发。

## 2. HTTP MCP 网关

- 提供经认证的服务器目录及 `/mcp/<server>` 端点。目录仅返回设备有权使用的服务器名和网关端点/安全元数据，不返回上游 URL、headers、env、OAuth token 或源引用。
- 仅转发中心已配置、启用、权限允许的 HTTP MCP。目标固定为中心配置，禁止请求指定任意上游/路径；禁止自动跟随重定向把凭据送往新目标。
- 网关验证设备 token、Origin、方法、路径、请求体大小；无效权限请求不得到达上游。配置有问题时拒绝访问。
- 请求只转发必要的 MCP 协议 headers（Content-Type、Accept、MCP-Protocol-Version、MCP-Session-Id、Last-Event-ID 等），去除设备 Authorization、Cookie、代理及 hop-by-hop headers；上游 headers 完全来自中心配置。
- 每次上游请求通过现有 SignIns.header 读取/刷新授权。插件自己拥有的 refresh 操作合并并发；原客户端借用授权继续只读。上游返回 401 时提示中心授权失效，不把上游 OAuth 登录转移给远端。
- 隔离会话：客户端随机 session id 映射到设备 + Provider + 服务器 + 上游 session id + 配置身份；不同设备或 Provider 不能复用会话。正确处理 POST、GET SSE、DELETE、404/过期、无状态上游。协议版本由上游协商，不改写 JSON-RPC 内容。
- 以流方式转发 JSON/SSE，正确取消、断连、超时和卸载；限制会话/请求资源，避免遗留 listener/stream/timer。撤销设备、关闭服务和权限变化后中止相关活动流并阻止后续请求。
- 错误与日志只包含安全的状态说明，不泄露 headers、凭据或上游敏感响应；不自动重试有副作用的 tools/call。

参考规范：

- https://modelcontextprotocol.io/specification/2025-11-25/basic/transports
- https://modelcontextprotocol.io/docs/2025-11-25/tutorials/security/security_best_practices

## 3. 其他机器连接

- 在其他机器保存中心 URL + 设备凭据（本机文件 600）。提供连接检查、刷新目录和断开操作，不回显已有 token。
- 连接表单一次勾选多个已获中心授权的 Provider，使用同一个设备 token，按 Provider 分别保存目录与连接状态；重复连接相同中心、token、Provider 时更新已有连接。未授权的选择显示错误且不注入，其余连接可正常使用。
- 每次目录和 MCP 请求用 X-Paseo-Provider 指定当前 Provider，中心核对授权列表并返回该 Provider 的目录；此头不转发上游。单 Provider 设备可省略此头以兼容旧客户端，多 Provider 设备必须明确指定。
- 创建新 Agent 时刷新授权目录，把网关 HTTP 配置（Authorization 为设备 token，X-Paseo-Provider 为当前 Provider）注入；保留调用方同名配置和本机同名配置优先规则，保留 Provider 的 MCP 总开关。
- 远端不调用本机 OAuth 给网关配置补上上游 token；这些配置不导入到本机 mcpServers 数据中。
- 网关离线、凭据撤销或授权失效要在共享页面显示清楚；不退回使用复制的上游凭据，不以成功缓存掩盖失败。已有 Agent 可继续保留端点，但中心撤销立即阻断其新调用。

## 4. 界面与文档

- 在现有页面加入“多机器”入口（优先复用 React Native kit 与中英文 ui），提供中心开关/地址/端口、运行状态/失败原因、设备创建、授权编辑与撤销，以及远端批量连接管理和共享目录。
- 一次性凭据显示与复制只发生在创建设备成功后；列表/轮询/readState 不暴露它。远端 token 输入隐藏。
- 显示“工具在中心机器执行”“中心需要在线”“远端使用中心账户权限”，HTTP 支持范围和借用授权的刷新限制。
- README 提供中心开启 → 创建设备 → 另一机器连接 → 新建 Agent 调用的操作步骤；同时给出正常 MCP 配置接入网关的方法，便于 Paseo 外的客户端使用。
- 不改真实 ~/.paseo、~/.codex 凭据，不启用正在使用的网关或重载生产 daemon；实现和验证先在仓库及临时数据目录完成。

## 5. 验收

- 两个独立客户端通过同一中心授权 initialize → initialized → tools/list → tools/call，均成功；远端看不到上游授权。
- 实际 HTTP/SSE 响应流与 DELETE、会话跨设备隔离、撤销设备、Provider/服务器权限变化、禁用服务器、上游 401、中心离线、重启与停止资源清理均有有效测试。
- 原客户端借用凭据变更被下一次调用读取；中心自有 OAuth 刷新并发不冲突。
- 目录、RPC、设备列表、错误与日志均不泄露上游凭据；客户端凭据不会转发上游。非法 Origin/任意 URL/重定向/过大请求被拒绝。
- 一个令牌对应多个 Provider 时，各自的目录、调用权限和会话仍隔离；批量连接按各 Provider 注入正确请求头，收窄授权只中止被移除的 Provider。兼容旧单 Provider 持久化数据，非法新列表拒绝加载。
- 旧共享服务器及技能测试通过；在 shared-tools 运行 npm run check（类型检查、测试、插件编译）。使用临时目录和假的上游，无真实账号写操作。
- 若未能接入真实第二台机器，明确说明已完成双客户端集成测试但跨物理机器验证未完成，不宣称已部署。

## 执行与审核

DeepSeek 依次完成配置/网关、远端接入、UI、测试/文档；每阶段报告变更文件、测试和剩余问题。主 Codex 检查差异、复跑 check、把发现的问题交还同一 DeepSeek 会话修复。只修改 shared-tools/，不修改其他插件或机器级设置。DeepSeek 不提交/推送；用户已授权主 Codex 在验收后提交并推送。
