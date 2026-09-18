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

- **生成速度**：Provider 上报的 `outputTokens` ÷ 模型实际工作时间。模型实际工作时间 = 本轮总耗时 − 工具执行等待 − 权限审批等待；包含思考（reasoning）时间与工具参数的生成时间。
- **全程速度**：`outputTokens` ÷ 从本轮开始到完成的时间。它会包含工具调用和审批等待。
- **TTFT**：从本轮开始到首个 reasoning 或 assistant 输出事件。
- 工具等待从该工具最后一次参数变化的 `running` 事件开始（Claude 会边生成边流式更新工具参数），到它 completed / failed / canceled 为止；多个并行工具以最后一个结束为准。审批等待从 `permission_requested` 到 `permission_resolved`，若审批的工具随后执行，则等待持续到工具结束。
- 插件不使用相邻输出事件的间隔来估算生成时间：Paseo 会把流式增量按 60 ms 合并，Claude 的 reasoning 摘要也是在思考结束后整段送达，事件间隔与真实生成时间无关。
- 本轮没有观察到任何流事件时只显示全程速度。
- `outputTokens` 由 Provider 上报，可能包含推理 token，具体含义取决于 Provider。
- Provider 不上报本轮输出 token 时，t/s 与 token 数显示 `—`，插件不会按字符数猜测。

因此，这些数字适合比较同一 Paseo 主机、相近任务下不同模型的实际交互速度，不等同于供应商公布的纯推理基准。

## 验证

```bash
npm ci --include=dev --ignore-scripts
npm run check
```
