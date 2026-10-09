# @tyza66/dsh-loop-agent

DSH web 配置文件的无尽同会话循环驱动器。每轮 agent 回答结束后，循环会在下一个回合边界自动注入用户可配置的延续提示，永远继续。同一个 Agent 和同一个 Session 贯穿整个运行，因此每一轮都能看到完整累积的对话记录。

## 特性

- **无尽循环**：每次回答后自动排队延续提示
- **指数退避**：失败的回合以指数退避重试（1s → 2s → 4s → ... → 32s）
- **自动回答问题**：运行中的问题自动回答（推荐选项、计划审查批准或第一个选项）
- **自动批准操作**：一次性工具批准自动授予
- **上下文压力处理**：上下文窗口错误在重试前触发自动压缩
- **/forever 命令**：在任何会话中输入 `/forever` 激活无尽循环
- **设置 UI**：Web 设置面板用于启用/禁用和配置延续提示
- **压缩**：重新启用 80% 自动压缩和 `/compact` 命令

## 安装

在 DSH 配置文件中安装插件：

```bash
dsh plugin install @tyza66/dsh-loop-agent
```

## 使用方法

1. **启用循环**：进入设置 → 无尽模式并打开开关
2. **激活会话**：在任何会话中输入 `/forever` 开始无尽循环
3. **配置**：在设置 → 无尽模式中编辑延续提示

循环永远运行，直到：
- 您在回合中点击停止按钮
- 您归档会话
- 您在设置中禁用循环

## 配置

插件可以在 `cordis.patch.yml` 中配置：

```yaml
- id: loop-runner
  name: '@tyza66/dsh-loop-agent'
  disabled: false
  config:
    continuation: '继续，并深度检查暗病，遇到暗病和缺陷就修复'
    initialBackoffMs: 1000
    maxBackoffMs: 32000
    backoffFactor: 2
    quiet: false
    idleGraceMs: 300000
    autoAnswerQuestions: true
    autoAnswerFreeText: true
    autoApproveActions: true
    escalateAfterFailures: 3
```

### 延续提示

延续提示支持占位符：

- `{{lastAnswer}}`：上一轮的助手文本
- `{{round}}`：从 1 开始的轮次编号（第 1 轮是第一次延续）
- `{{task}}`：在 web 模式中恒空（为与无头变体保持兼容）

## 工作原理

插件通过每秒轮询 `ctx.agents.roots()` 注册表，为每个顶级 agent 附加一个即发即弃的驱动程序。驱动程序：

1. 等待 agent 进入空闲状态
2. 切片会话日志以找到该轮最终的助手文本
3. 排队下一个延续提示
4. 永远重复

用户消息优先：客户端输入落在 `next-step`，而循环的延续落在 `next-turn`，收件箱 `claim("next-turn")` 顺序总是先拉取 `next-step`。

## 状态

运行时状态存储在 sidecar JSON 文件中，路径为 `$DSH_HOME/profiles/<profile>/.dsh-loop-agent.json`：

```json
{
  "disabled": false,
  "continuation": "自定义延续提示",
  "updatedAt": "2026-10-07T12:00:00.000Z"
}
```

## 许可证

MIT
