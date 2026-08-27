# Yuyu Reasoning Watchdog

SillyTavern 移动端优先的 reasoning 监工实验插件。

当前版本：**v0.3.1**

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

## v0.3.1 重点

- 保留 v0.3.0 单轮思维题卡实验。
- `MESSAGE_RECEIVED` 加入完成兜底，减少正文已落地但面板仍显示“生成中”的情况。
- 面板区分“卡片报告 T”和“可见 reasoning 本地估算”。
- 尝试从消息对象与主题消息卡捕获 `xxxxT`。
- 其他 Popup 打开时悬浮自动隐藏，关闭后恢复。

## 已知问题

- 部分移动端/主题下，生成结束事件仍可能漏触发，导致状态机停留在“生成中”。
- 某些主题的 `xxxxT` 可能由伪元素或非普通文本节点绘制，v0.3.1 可能显示“未捕获”。
- 当前回环算法主要检测文本重复与低信息增量，对“同义改写式语义回环”识别仍不够。
- `≈token` 只代表可见 reasoning 的本地估算，不代表 Gemini 服务端真实 Thinking token。

## 隐私

插件在本地运行，不上传聊天、reasoning、API Key 或统计数据。
