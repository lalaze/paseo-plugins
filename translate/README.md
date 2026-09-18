# Paseo Translate

在 Paseo 的 AI 对话中选中文字，点击选区旁的「翻译」，即可在原地查看结果。插件 ID：`paseo-translate`。

## 功能

- 只在对话中的用户消息和 AI 回复内显示划词入口，不修改聊天记录。
- 自动判断中日韩文字与其他语言的中英翻译方向，也可改选中文、英语、日语、韩语、法语、德语、西班牙语或俄语。
- 使用你填写的 OpenAI Chat Completions 兼容 API，不调用 Paseo 本地 Agent，也不会新建对话。
- API 地址、API Key 与模型按主机保存在 Paseo 插件设置中；同一时间最多处理 3 个请求。
- 支持复制结果，单次选区最多 5000 个字符。

## 安装

先在 Paseo 的 **Settings → Plugins** 开启插件，然后运行：

```bash
paseo plugin add lalaze/paseo-plugins --path translate
paseo reload
```

安装后打开 **Settings → Plugins → paseo-translate → 翻译 API**，填写：

- 完整 API 地址，例如 `https://api.openai.com/v1/chat/completions`
- API Key；免鉴权的本地兼容接口可以留空
- 模型名，例如 `gpt-4.1-mini`

翻译结果卡片右上角的「设置」也会打开同一配置页。修改后直接保存，无需 reload。

本地开发安装：

```bash
paseo plugin install "$PWD/translate"
paseo reload
```

## 隐私与限制

选中文字会由当前 Paseo 主机直接发送给你填写的 API，并消耗该服务的模型额度。API Key 保存在 daemon 主机的 Paseo 插件设置中，不会写入插件代码或仓库；非空 Key 会作为 `Authorization: Bearer` 请求头发送。划词浮层依赖浏览器选区 API，当前仅支持 Paseo 桌面端和 Web 端；iOS/Android 客户端不会启用入口。

## 开发检查

```bash
cd translate
npm ci --include=dev --ignore-scripts
npm run check
```
