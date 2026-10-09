# Paseo Translate

在 Paseo 的 AI 对话中选中文字，点击选区旁的「翻译」，即可在原地查看结果。插件 ID：`paseo-translate`。

## 功能

- 只在对话中的用户消息和 AI 回复内显示划词入口，不修改聊天记录。
- 桌面端和 Web 端可从命令中心打开独立的「翻译」页面：输入或粘贴文字后翻译，可选择目标语言并复制结果。
- iOS/Android 支持在每条已完成的 AI 回复下方显示「翻译」：点击展开中文译文，可收起、重新展开和复制。长回复会按每次最多 5000 个字符分段翻译全文。这个入口需要安装包含[客户端补丁](#手机端每条回复下方的翻译按钮)的 App，保留原回复的 Markdown、代码块和复制功能。
- 手机输入框旁的原生「译」按钮分为「写消息」和「读回复」：草稿翻译后可发送或复制，回复译文只提供复制。切换这两个页面会保留当前面板内的草稿与译文，关闭面板后清空。「翻译最新回复」会读取当前对话最后一条 AI 回复，分段翻译全文，默认译成中文。点击「发送译文」之前不会发出任何消息。旧版 App 同样支持这个入口，无需重新打包。
- 安装了[输入框草稿补丁](#手机端直接填入输入框)的 App 中，「写消息」的用法类似输入法自带的翻译栏：打开时自动带入主输入框里已写的中文并立即翻译，之后每次停顿 0.6 秒自动重新翻译；点击「填入输入框」用译文替换主输入框草稿，可继续修改后再发送，点击「发送」则直接发出译文并清空原草稿。主输入框里已是英文时不会再带入。
- 手机端长回复会显示分段进度，每完成一段就显示对应译文；某段失败时保留已完成的译文，点击「继续翻译」从失败段重试。全文完成后才启用复制；同一面板内重复翻译未变化的原文不会重复请求，修改 API 设置后则重新翻译。
- 手机草稿面板默认只显示自动、中文、英语三个常用选项，点击「更多」可展开其他语言；回复原文默认收起，可点击「查看原文」对照阅读。
- 鼠标悬停在 AI 回复的段落、列表项、引用或标题，或用户消息正文上时，旁边会浮现「译」按钮；点击后整段译文会以独立的段落块显示在原段落正下方，再次点击「收起」会隐藏译文、「展开」重新显示而不重复请求；块内的「×」会移除译文。
- 划词后点击「翻译」会直接在原消息下方生成行内翻译标签，不打开弹窗；同一段的多个标签紧凑横排、空间不足时自动换行，并可单独移除。
- 对话输入框旁提供「译」按钮：直接翻译当前草稿并原地替换，不自动发送；也可按 `Alt/Option + T`。翻译后按钮变为「撤销」，继续编辑后撤销自动失效。
- 输入框旁提供可持久记忆的「EN」严格英文模式；开启后会拦截以中文、日文、韩文、俄文等非拉丁文字为主的草稿，避免误发，并提示先点击「译」；英文中夹带的人名、术语和引用原文可以直接发送。还可按供应商或模型关键词自动硬锁。
- 按主要文字自动判断翻译方向：中日韩文字占多数时译为英文，否则译为中文，也可改选中文、英语、日语、韩语、法语、德语、西班牙语或俄语。
- 使用你填写的 OpenAI Chat Completions 兼容 API，不调用 Paseo 本地 Agent，也不会新建对话。
- 使用单条纯翻译提示词，同时兼容专用翻译模型与普通聊天模型，不绑定特定供应商或模型名。
- 本地接口与 Qwen 接口的翻译请求显式关闭思考模式；本地接口同时传入 `enable_thinking: false` 和 `chat_template_kwargs.enable_thinking: false`，DashScope 使用顶层开关。实际是否关闭取决于接口对这些参数的支持。参数用法见 [Qwen 文档](https://qwen.readthedocs.io/en/latest/deployment/vllm.html#thinking-non-thinking-modes)和 [DashScope 文档](https://www.alibabacloud.com/help/en/model-studio/deep-thinking)。
- API 地址、API Key 与模型（含可选的备用接口）按主机保存在 Paseo 插件设置中；同一时间最多处理 3 个请求，主接口与备用接口每次调用各最多等待 60 秒。
- 支持复制结果，单次选区最多 5000 个字符。
- 每次翻译 API 调用返回后，把时间、模型、主/备接口和返回的 token 用量追加到本机账本 `~/.paseo/translate/usage/YYYY-MM.jsonl`；同仓库的 [`usage-glance`](../usage-glance/README.md) 会把它作为「翻译」来源计入 Token 消耗统计。

## 安装

先在 Paseo 的 **Settings → Plugins** 开启插件，然后运行：

```bash
paseo plugin add git:lalaze/paseo-plugins --path translate
paseo reload
```

安装后打开 **Settings → Plugins → paseo-translate → 翻译 API**，填写：

- 完整 API 地址，例如 `https://api.openai.com/v1/chat/completions`
- API Key；免鉴权的本地兼容接口可以留空
- 模型名，例如 `gpt-4.1-mini`
- 自动 EN 锁模型关键词，例如 `claude, anthropic`；可用逗号、分号或换行分隔，留空即关闭自动锁
- 备用 API（可选）：地址、Key 与模型；主接口失败（超时、过载、报错等）时会自动用备用接口重试一次，留空则不启用

修改 API 设置后直接保存，无需 reload。需要用英文提问时，先在正常对话输入框中写中文，再点击旁边的「译」或按 `Alt/Option + T`；译文会替换当前草稿，但不会自动发送。翻译期间若草稿发生变化，插件会取消替换，避免覆盖新输入。

点击输入框旁的「EN」可开启严格英文模式，开启后显示为「EN锁」。该模式在浏览器本地即时检查并记住手动开关状态；它允许英文字母、数字、代码、URL、标点与 Emoji，拦截以非拉丁字母为主的内容。代码块、行内代码以及 `"…"`、`“…”`、`「…」`、`『…』`、`《…》` 中的内容按原文放行；未加引号的人名或短术语（如 `reply 验收通过 alone`、`ask 张三`）只要单段不超过约 8 个汉字、且英文单词明显占多数也会放行。整段中文即使夹杂少量英文单词仍会被拦截。由于不额外请求语言识别 API，它不能可靠区分英语、法语等同样使用拉丁字母的语言。

「自动 EN 锁模型」会对当前对话的 `供应商/模型名` 做不区分大小写的包含匹配。命中任一关键词时显示紫色「EN锁」，按钮会被直接禁用，无法点击关闭；切换到不命中的模型后，会恢复之前的手动 EN 状态。默认关键词为 `claude, anthropic`，你可以自行修改或清空。

在工作区多标签界面中，Paseo 不会把当前 Agent ID 持久保留在地址栏。插件会改为读取当前可见输入框的模型选择器；`Opus`、`Sonnet`、`Haiku`、`Fable` 和 `Mythos` 会自动识别为 Claude，因此默认的 `claude` 关键词同样生效。

本地开发安装：

```bash
paseo plugin install "$PWD/translate"
paseo reload
```

## Token 用量账本

只要 API 返回了响应（即使随后内容解析失败，token 也已消耗），插件就会向 `$PASEO_HOME/translate/usage/YYYY-MM.jsonl`（默认 `~/.paseo/translate/usage/`，可用 `PASEO_TRANSLATE_USAGE_DIR` 改到其他目录）追加一行 JSON：调用时间、模型名、`primary`/`fallback`，以及 OpenAI Chat Completions 的 `usage`（`prompt_tokens`、`completion_tokens`、`prompt_tokens_details.cached_tokens`、`completion_tokens_details.reasoning_tokens`）。接口没有返回 `usage` 时记为 `null`，统计页会提示有多少次调用缺少 token 数。账本不保存原文、译文、API 地址和 Key；写入失败不影响翻译。usage-glance 安装在同一台 daemon 主机上时会自动发现该目录，无需额外设置；删除该目录即清空历史。

## 手机端每条回复下方的翻译按钮

当前 Paseo 插件接口只能替换消息显示，不能在保留原生消息的同时追加按钮。本目录的 [`patches/native-reply-actions.patch`](patches/native-reply-actions.patch) 给客户端增加 `supportsTimelineAfter` 能力和 `placement: "after"` 时间线扩展。补丁基于 Paseo 提交 `bbbedd791ff25d66fcd08d5dc77ee94649b2ead4`（0.9.0-beta.2），没有改动服务端协议。

在 Paseo 源码目录应用补丁，随后按该项目的 Android/iOS 构建流程重新打包并安装手机 App：

```bash
git apply --check /absolute/path/to/paseo-plugins/translate/patches/native-reply-actions.patch
git apply /absolute/path/to/paseo-plugins/translate/patches/native-reply-actions.patch
npm run build:plugin
```

主机上也需要更新此翻译插件。单独执行 `paseo reload` 或更新 daemon 不会更新已安装的手机 App；旧版 App 不注册这个扩展，避免误把原文替换成按钮。

按钮支持已加载的历史回复，AI 回复完成后才出现。译文和分段进度仅保存在当前消息组件内，收起再展开不会重复请求；分段失败后继续翻译不会重复请求已完成的段落。退出对话或消息被列表回收后再次翻译会重新请求。译文不会发送给 AI，也不会写入聊天记录。长回复的各分段分别计入翻译用量。

## 手机端直接填入输入框

插件接口默认不能读写主输入框。[`patches/composer-draft.patch`](patches/composer-draft.patch) 给客户端插件上下文增加可选的 `composer.getText({ agentId })` / `composer.replaceText({ agentId }, text)`：改动集中在插件层（`packages/plugin` 与 `packages/app/src/plugins`），输入框组件只增加一处注册调用。已打开的输入框会立即显示新文字；该对话的输入框未打开时改写已保存的草稿。补丁取自 Paseo 个人分支提交 `a5a4ccc92`（基于 `v0.10.1-41-g64521057e`），需在[回复翻译补丁](#手机端每条回复下方的翻译按钮)之后应用，没有改动服务端协议：

```bash
git apply --check /absolute/path/to/paseo-plugins/translate/patches/composer-draft.patch
git apply /absolute/path/to/paseo-plugins/translate/patches/composer-draft.patch
npm run build:plugin
```

随后重新打包并安装手机 App。未打补丁的 App 不提供 `composer`，「写消息」保持原来的手动翻译、发送或复制。

## 隐私与限制

选中文字、在独立翻译页或「译」面板中提交的文字，以及点击回复下方「翻译」时的回复正文，会由当前 Paseo 主机直接发送给你填写的 API，并消耗该服务的模型额度。API Key 保存在 daemon 主机的 Paseo 插件设置中，不会写入插件代码或仓库；非空 Key 会作为 `Authorization: Bearer` 请求头发送。行内翻译批注不会写入或修改聊天记录。划词浮层、段落「译」按钮、输入框原地替换和 EN 锁依赖浏览器 API，仅支持 Paseo 桌面端和 Web 端；iOS/Android 的输入框旁「译」按钮在未打[输入框草稿补丁](#手机端直接填入输入框)的 App 中只能翻译后发送或复制，不能读取或替换主输入框的草稿；手机端不提供侧边栏入口和独立页面。停顿自动翻译每次停顿都会调用一次 API。两个手机回复翻译入口均以每段最多 5000 个字符翻译全文。

## 开发检查

```bash
cd translate
npm ci --include=dev --ignore-scripts
npm run check
```
