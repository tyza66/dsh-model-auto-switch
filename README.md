# @tyza66/dsh-loop-agent

Endless same-session loop driver for the DSH web profile. After every turn an agent finishes, the loop injects a user-configurable continuation prompt at the next turn boundary, forever. The same Agent and the same Session live for the whole run, so each round sees the full accumulating transcript.

## Features

- **Endless loop**: After every answer, a continuation prompt is queued automatically
- **Exponential backoff**: Failed turns retry with exponential backoff (1s → 2s → 4s → ... → 32s)
- **Auto-answer questions**: Mid-run questions are answered automatically (recommended option, plan-review approve, or first option)
- **Auto-approve actions**: One-shot tool approvals are granted automatically
- **Context pressure handling**: Context-window errors trigger automatic compaction before retry
- **/forever command**: Type `/forever` in any session to activate the endless loop
- **Settings UI**: Web settings panel for enabling/disabling and configuring the continuation prompt
- **Compaction**: Re-enables 80% auto-compaction and the `/compact` command

## Installation

Install the plugin in your DSH profile:

```bash
dsh plugin install @tyza66/dsh-loop-agent
```

## Usage

1. **Enable the loop**: Go to Settings → Endless loop and turn on the switch
2. **Activate a session**: Type `/forever` in any session to start the endless loop
3. **Configure**: Edit the continuation prompt in Settings → Endless loop

The loop runs forever until:
- You click the stop button during a turn
- You archive the session
- You disable the loop in Settings

## Configuration

The plugin can be configured in `cordis.patch.yml`:

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

### Continuation Prompt

The continuation prompt supports placeholders:

- `{{lastAnswer}}`: The previous round's assistant text
- `{{round}}`: 1-based round number (round 1 is the first continuation)
- `{{task}}`: Always empty in web mode (kept for parity with headless variant)

## How It Works

The plugin attaches a fire-and-forget driver to every top-level agent by polling the `ctx.agents.roots()` registry once a second. The driver:

1. Waits for the agent to go idle
2. Slices the session log to find the round's final assistant text
3. Queues the next continuation prompt
4. Repeats forever

User messages take priority: client input lands in `next-step` while the loop's continuation lands in `next-turn`, and the inbox `claim("next-turn")` order always pulls `next-step` first.

## State

Runtime state is stored in a sidecar JSON file at `$DSH_HOME/profiles/<profile>/.dsh-loop-agent.json`:

```json
{
  "disabled": false,
  "continuation": "Custom continuation prompt",
  "updatedAt": "2026-10-07T12:00:00.000Z"
}
```

## License

MIT
