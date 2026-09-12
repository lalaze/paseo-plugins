# Antigravity Hub ACP（Preview）

`hub.mjs` 将本机 Antigravity Hub 接入 Paseo 的 ACP provider。与 [额度补丁](../agy-quota/README.md) 独立，支持模型选择、流式回复、工具进度、逐次审批、取消及本桥接创建的会话恢复。本目录是 [paseo-plugins](../README.md) 中的配套扩展，通过写入 Paseo 配置安装，不是 `paseo plugin` 包。Provider ID 为 `antigravity-hub`。

## 安装

```bash
git clone git@github.com:lalaze/paseo-plugins.git
cd paseo-plugins/antigravity-hub
node hub.mjs check
npm test
node hub.mjs install
paseo reload
```

安装只管理 `agents.providers.antigravity-hub`，开启 `params.supportsMcpServers`。已受管理的旧版纯文本 preview 可直接升级，保留首次安装前的回退目标；用户自行改动过该条目时拒绝覆盖。本目录路径必须保持可用。`AGY_HUB_BIN` 默认 `~/.gemini/bin/agy`；`AGY_HUB_STATE_DIR` 可指定桥接会话状态目录。

已有未受本脚本管理的同名条目时：

```bash
node hub.mjs install --replace-existing
paseo reload
```

## 更新

本仓库源码更新后：

```bash
cd /path/to/paseo-plugins
git pull
cd antigravity-hub
node hub.mjs check
npm test
node hub.mjs install
paseo reload
```

`install` 在已受管理且命令路径未变时会就地升级 provider；已安装且内容相同则不做修改。启动命令或 `AGY_HUB_BIN` 变了时，先卸载再安装。用户自行改过该条目时拒绝覆盖。

从旧仓库路径迁过来时，不要拷贝旧 `.state/`（里面记录的是旧 `hub.mjs` 路径）。在旧目录执行 `node hub.mjs rollback`，再在本目录安装。

## 卸载

```bash
cd /path/to/paseo-plugins/antigravity-hub
node hub.mjs rollback
paseo reload
```

回退只还原 `agents.providers.antigravity-hub`，首次安装前若没有该条目则删除它。备份保留在本目录 `.state/`，已被 Git 忽略。不要在仍生效时单独删除 `.state/`。本目录路径被移走后，已写入配置的 `command` 会失效，需要先回退或重新安装。

## 功能

回复显示：桥接会为包含 Markdown 围栏的 `diff`/`patch` 回复使用足够长的外层围栏，保持 diff 正文不变。普通文字继续流式显示，diff 代码块在闭合或回复结束后显示；恢复会话时同样处理。命令工具卡片显示实际命令、工作目录和原始终端输出。读、搜、改文件会分别标成 `read` / `search` / `edit`，供 Paseo 汇总「N 个命令和 M 个其他工具」。

Plan 模式：`session/new` 声明 `default` 与 `plan`。Plan 下只探索并写出实现计划，回合结束会发出 ACP `switch_mode` 权限（Proceed / Stay in plan）。点 Proceed 或回复「确认」后切回 default，并通知 Hub 开始执行。`implementation_plan.md` / `plan.md` 作为计划正文展示，同时发送 ACP `plan` 条目。不提供权限绕过模式。

### 图片

接受 Paseo 标准 ACP `image` 内容块，将 base64 图片送入 Hub 的 `media.inlineData`，支持与文本混合以及纯图片消息。支持 PNG、JPEG、GIF、WebP；每条消息的图片合计上限为 20 MiB。非法 base64 或不支持的 MIME 会明确报错。恢复历史时回传 Hub 提供的内联图片；不主动下载图片 URL。已通过真实 Paseo `--image` 上传和模型识别验证。

### Paseo 注入的 MCP

接受 `session/new` 和 `session/load` 的 `mcpServers`，支持 Paseo 的无 `type` stdio 格式以及 HTTP/SSE 格式。逐项转换命令、参数、环境变量、URL 和认证头，stdio 工作目录使用会话 cwd。MCP 配置限定于会话，不写入 Antigravity 全局 MCP 文件；桥接自己的会话状态只保存 ID、工作目录和模型，恢复时使用 Paseo 本次传入的地址与凭证。Hub 本身仍管理其会话历史。

Paseo `0.7.2` 默认关闭内置 MCP 自动注入。仅开启 provider 的能力声明不会产生 MCP 服务列表。若要让 Paseo 注入自己的内置工具，需要在 Paseo 配置中设置：

```json
{
  "daemon": {
    "mcp": {
      "enabled": true,
      "injectIntoAgents": true
    }
  }
}
```

合并进现有配置后执行 `paseo reload` 并新建会话。这个开关影响整个 daemon 的 agent，`hub.mjs install` 不会自动修改它。独立测试 daemon 可使用单独的 `--home` 和回环端口验证，避免改变现有 agent。

**当前限制：** 本机 Hub `2.12.2` 在新会话首次发送消息时，注入的 MCP 工具有首轮发现滞后；随后同一会话的工具调用正常。已用真实 stdio、HTTP 测试服务复现并确认调用结果；独立 Paseo daemon 的带认证 HTTP 注入也已实测，第二轮成功调用 `list_agents` 并返回 `agents_count=1`，尚不能保证首轮可用。桥接不发送隐藏的模型预热提示词，也不自动重复用户工具操作。遇到工具尚未可用时需再次发送请求。这仍是 preview，不能视为首轮 MCP 完整验收通过。

协议依据：[ACP 会话与 MCP 配置](https://agentclientprotocol.com/protocol/session-setup)、[Session Modes](https://agentclientprotocol.com/protocol/session-modes)。Hub 字段依据本机客户端 protobuf 描述符和真实 RPC 验证。自动测试覆盖图片转换、输入拒绝、三种 MCP 配置、恢复时凭证更新、审批/拒绝/取消、Plan 模式 Proceed 确认与回复确认、provider 升级与精确回退；`npm test` 不调用真实模型。
