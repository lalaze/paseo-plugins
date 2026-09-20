# Paseo Antigravity 额度补丁

为 Linux 和 macOS 上的 Paseo **Plan usage** 增加当前 Google Antigravity 账号的额度。独立保存补丁源码、兼容性基线、测试和回退工具，不需要修改或重新构建 Paseo 前端。本目录是 [paseo-plugins](../README.md) 中的配套补丁，不是 `paseo plugin` 包。

**直接查看额度：** Paseo 0.8.x 可安装 [额度速览插件](../usage-glance/README.md)，电脑端工作区右上角默认显示最低剩余额度及供应商，也可在展开后固定某一个供应商。切换聊天、终端或文件仍可查看。点击顶部额度展开全部明细，不必进入设置。该展示插件独立安装，复用已有额度数据。

支持基线：Paseo `0.7.2`、Node.js `22+`、Linux 或 macOS、已登录的 Antigravity `agy`。使用 Paseo 自带的 `node-pty`；测试需要 `openssl` 和绑定本机回环端口的权限。macOS 用系统自带的 `/usr/sbin/lsof` 和 `/bin/ps` 查找本进程拥有的端口。没有额外 npm 依赖，不需要 `npm install`。

安装、更新、卸载都在本目录用 `patch.mjs` 完成，并需要重启 daemon。

## Claude 额度查询限频（可选）

`claude-patch.mjs` 适配已检查的 Paseo **0.8.0** Claude 读取器。默认 daemon 的额度缓存为 5 分钟，界面每分钟读取本机缓存；单台 daemon 正常持续打开时，每小时最多约 12 次 Claude 外部查询。此独立补丁把 Claude 查询间隔提高到 **15 分钟**，每小时最多约 4 次，多个页面和手动刷新共用限制。其他供应商的缓存不变。

收到 **429** 时，遵守 `Retry-After` 的秒数或 HTTP 日期；缺失或无效时等待 **1 小时**，短于 15 分钟时仍遵守最小查询间隔。请求失败也不会立即重试。正常结果只在当前 daemon 内存中缓存，因此 Claude 数字最多可能落后 15 分钟；限流恢复还需等下一次 daemon 缓存刷新。

冷却截止时间保存在 `$PASEO_HOME/cache/claude-quota-throttle.json`（默认 `~/.paseo/cache/claude-quota-throttle.json`），重启不会绕过等待。该文件不保存凭证和额度响应。重启后尚在冷却期时暂不显示 Claude，等下一次允许查询后恢复。不同机器的 daemon 各自计数，同一账号在其他软件中的查询不受此补丁控制。

```bash
cd /path/to/paseo-plugins/agy-quota
node claude-patch.mjs check
node claude-patch.mjs apply
# 确认当前任务与终端可以中断后：
paseo daemon restart
```

安装时自动运行离线测试，不访问 Claude 接口。原始文件保存在 `.state/claude-*.json`，`node claude-patch.mjs rollback` 可恢复，回退后同样需重启。Paseo 升级可能覆盖补丁，需重新执行 `check` / `apply`；未知上游文件会拒绝修改。

## 安装

```bash
git clone git@github.com:lalaze/paseo-plugins.git
cd paseo-plugins/agy-quota
node patch.mjs check
npm test
node patch.mjs live
node patch.mjs apply
paseo daemon restart
```

在 Paseo 中打开 **Plan usage** 并点击 **Refresh**。新增 **Google Antigravity 2.0**，优先显示 Gemini 和 Claude/GPT 两组各自的周额度与 5 小时额度。进度条表示**已使用**百分比，与 Paseo 其他项目一致，例如剩余 80% 显示已用 20%。仅显示真实返回的重置时间。

`live` 只读取额度，不发送模型提示词，不消耗生成 token；它会打印当前账号的额度，但不输出账号标识或凭证。后台 `agy` 可能正常刷新它自己管理的登录状态。界面沿用 Paseo 原有缓存和 Refresh 行为。

脚本从 PATH 中的 `paseo` 定位安装。nvm 切换后，确认 PATH 指向实际运行的 Paseo；也可指定：

```bash
node patch.mjs check --cli /absolute/path/to/node_modules/@getpaseo/cli
```

所有命令均支持 `--cli`。需拥有目标安装目录写权限，脚本不会自动执行 sudo 或更新 Paseo。本目录路径必须保持可用。

## 更新

本仓库源码更新后：

```bash
cd /path/to/paseo-plugins
git pull
cd agy-quota
node patch.mjs check && node patch.mjs apply
paseo daemon restart
```

Paseo 更新或重装可能覆盖安装目录内的补丁，但不会删除本仓库。之后同样运行：

```bash
cd /path/to/paseo-plugins/agy-quota
node patch.mjs check && node patch.mjs apply
paseo daemon restart
```

**仅在上一条命令成功后重启。** `apply` 会再次检查并自动运行测试，已应用时不重复修改。`check` 比较额度注册表、共享辅助函数、服务缓存实现、ProviderUsage 协议和 node-pty 版本。新版即使版本号不同，也只有这些边界与已验证基线一致时才能应用。任一变化会报错并停止，不提供跳过检查的强制选项。不要只更新 `compatibility.json` 的哈希来绕过失败；应检查上游实现、适配并重新测试。上游原生支持 Antigravity 时应优先使用原生功能。

若两项补丁都在使用，Paseo 更新后：

```bash
cd /path/to/paseo-plugins/agy-quota
node patch.mjs check &&
node kimi-patch.mjs check &&
node patch.mjs apply &&
node kimi-patch.mjs apply &&
paseo daemon restart
```

也可把 `bin/paseo` 放进 PATH，在 `daemon restart` 时自动检查并重装补丁，见下方「升级后自动恢复额度补丁」。

## 卸载

```bash
cd /path/to/paseo-plugins/agy-quota
node patch.mjs rollback
paseo daemon restart
```

原始注册表、安装路径和文件哈希保存在本目录 `.state/` 中，已被 Git 忽略；保留该目录才能精确回退。注册表最后原子替换以激活补丁。回退前核对当前文件与应用时一致，避免覆盖 Paseo 更新或其他人的修改。回退只恢复注册表并删除本补丁的两个文件，保留备份。

不要在补丁仍生效时删除或移动本目录的 `.state/`。若要移动，连同 `.state/` 一起移动。Paseo 升级后若文件已改变，不能把旧备份强行覆盖到新版。

仅卸载 Kimi、保留 Google Antigravity：

```bash
cd /path/to/paseo-plugins/agy-quota
node kimi-patch.mjs rollback
paseo daemon restart
```

没有旧仓库、因而没有 `.state` 备份时，不要 `rollback`。用 `recover` 按已知补丁格式还原官方文件（会对照兼容性哈希，对不上就拒绝）：

```bash
cd /path/to/paseo-plugins
node patch.mjs recover
node kimi-patch.mjs recover
node patch.mjs apply
node kimi-patch.mjs apply
paseo daemon restart
```

## 数据来源与边界

- 从 Paseo 当前 `antigravity-acp.env.AGY_BIN`、`antigravity-hub.env.AGY_HUB_BIN`、`AGY_HUB_BIN` 读取路径，其次 `PATH` 中的 `agy`，再是 `~/.local/bin/agy`、Homebrew、`/usr/local/bin/agy`、`~/.gemini/bin/agy`。可用 `PASEO_ANTIGRAVITY_BIN` 指定绝对路径。配置目录沿用 `PASEO_HOME` 或 `~/.paseo`。
- 仅复用同 UID、同一 `agy` 二进制的进程：Linux 用 `/proc` 匹配 inode 或 `/proc/pid/exe` 路径（含文件已被替换后的 `(deleted)`），并读取该进程拥有的监听 socket；macOS 用 `lsof`/`ps` 做同等范围的查找；不会扫描不相关的本地服务。
- Hub 的 CSRF 来自该进程回环页面的 `window.__APP_CONFIG__`，不是命令行 `--csrf_token`。agy 1.2 CLI 不再在无参数启动时提供 LanguageServerService。
- 若复用失败，启动专用短生命周期 Hub（`--hub`），只调用本地 HTTPS API，不输入提示词；读取结束后仅清理自己创建的进程。
- 优先 `RetrieveUserQuotaSummary`；旧版回退到 `GetUserStatus` / `GetCommandModelConfigs` 中的显式 `quotaInfo`。缺失值、模型可用性和不明积分不推算成配额。
- 本地自签名 TLS 例外仅限进程拥有的 `127.0.0.1` 端口，不修改全局 TLS 设置。读取有超时和 1 MiB 响应上限。
- 凭证由 `agy` 管理，补丁不复制、不修改凭证文件，不上传账号数据。原始响应和 CLI 输出不写入 Paseo 日志。
- 未登录、接口变化或读取失败显示 Unavailable。可先在终端运行 `agy` 的 `/usage` 检查登录和实际额度，再运行 `node patch.mjs live`。

当前支持 Linux 和 macOS，尚未实现 Windows；不提供账号切换或 Gemini API 项目账单。

参考：[Google Antigravity /usage 文档](https://antigravity.google/docs/cli/commands/usage/)、[CodexBar Antigravity 接口说明](https://github.com/steipete/CodexBar/blob/main/docs/antigravity.md)。实现针对本机真实响应编写，测试使用合成数据。

## Kimi 按需续期补丁（可选，独立安装/回退）

Paseo 的 Kimi 读取器只读取凭证文件，不负责续期。当 OAuth access token 过期时会显示 Unavailable。此扩展在查询前检查 `expires_at`：剩余不超过 5 分钟且有 refresh token 时，调用 **Kimi 自己的认证逻辑** 续期，再重新读取凭证并执行原有额度请求。有效凭证和环境变量 API key 保持原查询路径。

已验证 Kimi Code `0.42.0`。不需要常驻 `kimi web`，不发送模型消息，也不运行交互式 `kimi login`。临时执行 `kimi web --no-open --host 127.0.0.1 --port 0`，用 Kimi 自己的本地 server token 调用 `/api/v1/oauth/usage`；该接口执行 `ensureFresh()`，由 Kimi 管理跨进程锁、refresh token 轮换和原子写回。模型目录启动刷新被禁用。调用结束后只清理此次创建的私有进程组。

### 安装

```bash
cd /path/to/paseo-plugins/agy-quota
node kimi-patch.mjs check
node kimi-patch.mjs live
node kimi-patch.mjs apply
paseo daemon restart
```

此补丁独立修改 `providers/kimi.js` 并添加 `providers/kimi-refresh.js`，不依赖 Google 读取器。备份仍在 `.state/`，不会上传到 Git。支持与 `patch.mjs` 相同的 `--cli` 参数。`PASEO_KIMI_BIN` 可指定 Kimi 绝对路径，默认优先使用 Paseo 配置的 Kimi 命令，再回退到 `~/.kimi-code/bin/kimi`。临时服务使用当前凭证文件所属的 Kimi home，避免混用账号目录。

### 更新

Paseo 或本仓库更新后，若两项补丁都在使用，按上面「更新」一节同时 `check` 再 `apply`。只更新 Kimi：

```bash
cd /path/to/paseo-plugins/agy-quota
node kimi-patch.mjs check && node kimi-patch.mjs apply
paseo daemon restart
```

### 卸载

```bash
cd /path/to/paseo-plugins/agy-quota
node kimi-patch.mjs rollback
paseo daemon restart
```

Kimi 扩展会检查上游 Kimi 读取器和共享额度工具的哈希，拒绝覆盖不兼容代码。Kimi CLI 本地 API 将来改变时，续期会有界失败而不会绕过认证；需要更新扩展。并发请求按凭证路径合并；失败后冷却 60 秒，后续查询再尝试。Paseo 原有 5 分钟额度缓存保持不变，因此之前的 Unavailable 可能仍显示到下一次缓存过期。撤销登录或 refresh token 失效仍需用户重新登录，不能自动绕过。

## Grok 按需续期补丁（可选，独立安装/回退）

Paseo 原来的 Grok 额度读取器直接使用 `~/.grok/auth.json`，不会续期。Grok CLI 可以自行续期并继续对话，但额度读取可能因旧令牌返回 401，在顶栏被隐藏。此补丁在每次读取时检查所选 OIDC 凭证：剩余不超过 5 分钟且有 refresh token 时，先调用 Grok 自己的续期逻辑，再重新读取磁盘令牌查询额度。其他 Grok 进程已经更新的令牌也会被重新读取。

已在 macOS、Paseo `0.8.0`、Grok `1.0.34` 验证。临时运行 `grok agent --no-leader stdio`，只发送 ACP `initialize`；不创建 session、不发送 prompt。Grok 管理跨进程认证锁、refresh token 轮换及凭证写回。进程的 `GROK_HOME` 和 `GROK_AUTH_PATH` 指向额度读取器正在使用的凭证文件；不连接用户现有 leader。15 秒内未成功续期就结束，随后清理此次创建的私有进程组。

```bash
cd /path/to/paseo-plugins/agy-quota
node grok-patch.mjs check
node grok-patch.mjs live
node grok-patch.mjs apply
paseo daemon restart
```

补丁只修改 `providers/grok.js` 并添加 `providers/grok-refresh.js`，备份独立保存在 `.state/`。支持 `--cli /path/to/@getpaseo/cli`；`PASEO_GROK_BIN` 可指定 Grok 绝对路径，否则按 Paseo 配置、PATH、`~/.grok/bin/grok` 查找。凭证位置仍沿用 Paseo Grok 读取器的 `~/.grok/auth.json`，不会改变账号选择规则。有效凭证、旧版静态凭证、环境变量 `GROK_API_KEY` / `GROK_TOKEN` 不启动续期进程。

并发请求按凭证路径合并，失败后冷却 60 秒，CLI 输出和凭证不会写入 Paseo 日志。Paseo 原有 5 分钟额度缓存保持不变；授权撤销或 refresh token 失效时仍需要 `grok login`。本补丁不把 401 当作额度为零。

更新时重新执行 `check`、`apply`、重启。卸载仅影响 Grok：

```bash
node grok-patch.mjs rollback
paseo daemon restart
```

缺失 `.state` 时可使用 `node grok-patch.mjs recover`，只对兼容性哈希匹配的已知补丁还原。测试覆盖续期后请求真正使用新令牌、有效凭证/API key 跳过续期、并发、失败冷却、超时、进程清理和精确回退。

实现依据：[Grok 官方认证与自动续期说明](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-shell/README.md)、[官方续期锁与写回逻辑](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-login/src/manager/refresh_chain.rs)。真实验证只比较令牌是否变化及到期时间是否延长，不输出凭证。

## 升级后自动恢复额度补丁

本目录提供 `bin/paseo` 守卫入口。将它放在真实 Paseo 之前的 PATH 后，普通命令直接透传；`start`、`restart`、`daemon start`、`daemon restart` 和 `onboard` 会先定位当前 nvm/npm 安装的真实 CLI，再运行兼容性检查并按需重装 Google Antigravity、Kimi 和 Grok 续期补丁。已安装时不会重复写文件；任一补丁与新版不兼容时会在停止旧 daemon 之前拒绝执行，避免盲目覆盖。守卫会启用全部三项补丁；要长期单独卸载其中一项，应使用真实 Paseo 入口启动，否则下次守卫启动时会重新安装。

```bash
ln -sfn "$PWD/bin/paseo" ~/.local/bin/paseo
export PATH="$HOME/.local/bin:$PATH"
paseo daemon restart
```

守卫不修改 npm 或 nvm 安装，也不固定 Paseo 的版本路径，因此正常升级 CLI 后仍会发现新安装。直接使用真实 Paseo 的绝对路径会绕过守卫。

测试涵盖有效/过期凭证、API key 不受影响、并发续期、失败冷却、超时和进程清理、重新读取凭证，以及补丁重复应用、变更拒绝和精确回退。测试使用合成凭证；真实验证只报告令牌是否变化和有效期是否延长，不输出凭证。
