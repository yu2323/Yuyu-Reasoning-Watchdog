# Yuyu Reasoning Watchdog

SillyTavern 移动端优先的 reasoning 监工实验插件。

当前版本：**v0.3.3**

## 当前能力

- 实时读取 SillyTavern 可见 reasoning 文本，统计字符、5-gram 重复、信息新颖度、标题回环和综合回环指数。
- 读取 ST 保存的 `reasoning_duration` 作为完成后的思考耗时优先口径。
- 尝试读取宿主/主题消息卡片显示的 `xxxxT`，单独标记为“卡片报告 T”；不会把它冒充 Gemini 官方 `thoughtsTokenCount`。
- 通过 `CHAT_COMPLETION_PROMPT_READY` 支持单轮“思维题卡”实验；题卡只影响当前请求，不写入聊天历史，不修改 Yuyu 预设。
- 其他 SillyTavern 原生 Popup 打开时，悬浮监控自动避让。
- 监控面板使用 SillyTavern 原生 Popup；扩展设置使用原生 `extension_container + inline-drawer` 结构，针对移动端验证。

> 当前仍是实验版：只监控/提示，不会自动停止生成。

## Git 安装

在 SillyTavern：

1. 打开“扩展程序”。
2. 选择“安装扩展程序”。
3. 选择 **Install from Git URL**。
4. 填入：`https://github.com/yu2323/Yuyu-Reasoning-Watchdog`
5. 安装后刷新页面。

以后更新直接在 SillyTavern 的扩展管理里对本扩展执行更新，不需要重新下载 ZIP。

## v0.3.3 重点

- 继承 v0.3.2 的生成结束兜底、ST tokenizer 可见 token、消息卡 T 深扫与疑似截断提示。
- 固定题卡升级为“本轮推进锚点”：先确定这一轮真正要决定的下一步，之后只保留会直接改变下一步的判断。
- 明确禁止为了“考虑周全”继续枚举远期后果、备用假设、象征意义或无直接因果关系的支线；证据不足时保留未知，不展开假设树。
- 群像/环境变量只要会直接改变本轮下一步仍必须纳入，避免把“防跑题”做成二人转或世界静止。
- 本版仍不自动停止生成；如果锚定题卡仍压不住跑题，再进入手动接管/停止后重试实验，而不是继续堆 Prompt。

## v0.3.2 监测修正

- 保留 v0.3.0 / v0.3.1 的题卡与 UI，不改回环算法。
- 读取 SillyTavern `is_send_press` 作为生成状态兜底；即使移动端漏掉结束事件，也能在宿主回到空闲后完成本轮结算。
- 可见 reasoning token 优先调用 SillyTavern 自己的 `getTokenCountAsync()`；失败时才显示 `≈` 字符估算。
- `xxxxT` 扫描扩展到消息 chrome 的属性、`data-*`、`title/aria-*` 与 CSS `::before/::after`，仍只标记为“卡片 T”。
- 完成后检查 provider finish reason 与正文句尾，显示“疑似截断”，不自动续写。

## 已知问题

- 锚定题卡只能在请求开始前约束推理方向，不能在同一次 Gemini 原生 Thinking 已经跑偏后中途再塞一句话纠偏。
- 主题若把 `xxxxT` 画在 Shadow DOM / canvas 或插件私有状态里，仍可能显示“未捕获”。
- 当前回环算法主要检测文本重复与低信息增量，对“同义改写式语义回环”识别仍不够。
- “可见 token”只统计 SillyTavern 能看到的 reasoning 文本；即便使用 ST tokenizer，也不等于 Gemini 服务端全部 hidden Thinking token。

## 隐私

插件在本地运行，不上传聊天、reasoning、API Key 或统计数据。
