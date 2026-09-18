# 回复测速

在每轮 AI 回复后显示当前 Provider / 模型的生成速度，包括：

- 生成速度（t/s）
- 输出 token 数
- 首字延迟（TTFT）
- 全程平均速度与总耗时

插件 ID：`paseo-response-speed`。

## 安装

先在 Paseo 的 **Settings → Plugins** 开启插件，然后运行：

```bash
paseo plugin add lalaze/paseo-plugins --path response-speed
```

本地开发安装：

```bash
paseo plugin install "$PWD/response-speed"
```

安装或更新后执行 `paseo reload`。新完成的回复会在时间线中保存一条测速卡片；安装前的历史回复不会补算。

## 口径

- **生成速度**：Provider 上报的 `outputTokens` ÷ 首个至末个可见输出事件的时间。只有观察到有效的流式区间时才显示。
- **全程速度**：`outputTokens` ÷ 从本轮开始到完成的时间。它会包含首字等待、工具调用和模型之间的停顿。
- **TTFT**：从本轮开始到首个 reasoning 或 assistant 输出事件。
- 一轮若有多段模型输出，生成速度的区间也会包含这些输出之间的工具调用或等待时间。
- `outputTokens` 由 Provider 上报，可能包含推理 token，具体含义取决于 Provider。
- Provider 不上报本轮输出 token 时，t/s 与 token 数显示 `—`，插件不会按字符数猜测。

因此，这些数字适合比较同一 Paseo 主机、相近任务下不同模型的实际交互速度，不等同于供应商公布的纯推理基准。

## 验证

```bash
npm ci --include=dev --ignore-scripts
npm run check
```
