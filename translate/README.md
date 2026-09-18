# Paseo Translate

在 Paseo 的 AI 对话中选中文字，点击选区旁的「翻译」，即可在原地查看结果。插件 ID：`paseo-translate`。

## 功能

- 只在对话中的用户消息和 AI 回复内显示划词入口，不修改聊天记录。
- 自动判断中日韩文字与其他语言的中英翻译方向，也可改选中文、英语、日语、韩语、法语、德语、西班牙语或俄语。
- 优先复用当前对话的供应商与模型；无法识别当前会话时，使用本机第一个已启用且可用的模型。
- 翻译在隐藏的一次性内部会话中运行，结束后自动归档；同一时间最多处理 3 个请求。
- 支持复制结果，单次选区最多 5000 个字符。

## 安装

先在 Paseo 的 **Settings → Plugins** 开启插件，然后运行：

```bash
paseo plugin add lalaze/paseo-plugins --path translate
paseo reload
```

本地开发安装：

```bash
paseo plugin install "$PWD/translate"
paseo reload
```

## 隐私与限制

选中文字会发送给当前 Paseo 主机上配置的 AI 供应商并消耗相应模型额度，不会发送到额外的翻译服务。划词浮层依赖浏览器选区 API，当前仅支持 Paseo 桌面端和 Web 端；iOS/Android 客户端不会启用入口。

## 开发检查

```bash
cd translate
npm ci --include=dev --ignore-scripts
npm run check
```
