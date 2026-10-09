import z from "@deepseek-ai/schemastery";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { readFileSync } from "node:fs";
import { readDisabled, readContinuationOverride, writeDisabled, writeContinuation } from "./patch-state.js";

/**
 * This bundle's own version, read once at module load from the package.json
 * that ships next to this file. Single source of truth: the settings panel
 * shows exactly what `npm publish` shipped, never a hardcoded copy that can
 * drift. Degrades to null when the manifest is unreadable (e.g. a bundler
 * strips it) so the client can simply hide the badge.
 */
const BUNDLE_VERSION = (() => {
  try {
    return JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version ?? null;
  } catch {
    return null;
  }
})();

//#region lib/types/index.js
/**
 * @tyza66/dsh-loop-agent — endless same-session loop driver for the dsh web profile.
 *
 * Rides alongside the default web-app bundle. After every turn an agent
 * finishes, the loop injects a user-configurable continuation prompt at the
 * next turn boundary, forever. The same Agent and the same Session live for
 * the whole run, so each round sees the full accumulating transcript.
 *
 * User messages take priority by inbox construction: client input lands in
 * `next-step` while the loop's continuation lands in `next-turn`, and the
 * inbox `claim("next-turn")` order always pulls `next-step` first. The loop
 * only acts on `agent.whenIdle()`, so it cannot preempt in-flight work; once
 * the user stops sending, the agent runs the queued continuation, goes idle,
 * and the loop queues the next one.
 *
 * The loop never exits on its own. Any failure — turn-level LLM error,
 * thrown exception in the driver body, network blip that the LLM surfaces
 * as a turn error, even a transient context overflow — falls through to
 * exponential backoff and the previous round's prompt is re-sent. The only
 * exits are the user clicking the stop button during a turn (the round ends
 * `aborted` and the driver halts — "endless until the user manually
 * stops"), the agent leaving the live registry (the supervisor observes
 * that by polling `agents.list()`, which is the replacement for the
 * scope-filtered `agent/disposed` event that a root plugin never receives)
 * or the host tearing the plugin down. Archiving a conversation in the UI
 * also stops its run: archiving never disposes the agent, so without the
 * check below the loop would keep burning tokens on a hidden session — the
 * supervisor polls the workspace registry's archive set and halts (and
 * cancels) any driver whose session is archived. A turn preempted by a new
 * user message (`interrupted`) is neither — the driver waits for that turn
 * to settle and resumes, so an interjected question does not kill the run.
 *
 * Mid-run interaction is auto-defaulted so an endless run never parks on a
 * human: while the loop is enabled, a question the agent asks through
 * `ask_user_question` is answered with the recommended option (label
 * marker `(推荐)` / `(Recommended)`, a `plan-review` intent's approve
 * choice, or the first option), a free-text question (no options) is
 * answered with a standing "unattended — decide autonomously" grant
 * (`autoAnswerFreeText`, never a fake human reply), and a tool call that
 * needs one-shot approval is granted `allowed-once`. All of these only
 * apply to agents this plugin drives (loop on, driver armed), are
 * configurable (`autoAnswerQuestions` / `autoAnswerFreeText` /
 * `autoApproveActions`), and leave sessions the user is interacting with
 * directly on the normal ask/approve UI.
 *
 * Failed turns never end the run: the loop retries with exponential
 * backoff forever. Once the SAME retry prompt has failed
 * `escalateAfterFailures` times, the identical resend is replaced by an
 * escalation prompt carrying the latest error so the model routes around
 * the failing operation instead of repeating it; further failures keep
 * producing fresher escalation prompts until a turn completes (the failure
 * chain then resets). A turn the user aborted or an archived session still
 * halts the run — "endless until the user manually stops" is the contract.
 *
 * Context-window pressure is *not* the loop's job. 80% / `/compact` is wired
 * by re-enabling `dsh-compaction-basic` (auto) and `dsh-command-compact`
 * in the patch; the loop and the compactor are orthogonal, and the
 * compactor runs in the same session.
 *
 * @module @tyza66/dsh-loop-agent
 */
/** Stable Cordis plugin name. */
const name = "loop-runner";

/** Service dependencies the apply step needs before registering hooks. */
const inject = [
  "agents",
  /**
   * The webserver is how the browser half reaches this plugin: the client
   * calls `/api/loop-agent/{state,enabled,continuation}` and these routes
   * translate the HTTP request into the same file write the host used to do
   * via the dynamic-only `harness` channel. Static dual-face packages never
   * see a `harness` service, so the webserver is the only documented bridge.
   */
  "webServer",
  /**
   * The commands service registers `/forever` as a slash command so the UI
   * input box shows it in autocomplete and the command lifecycle is logged
   * to the session. Without this, users typing `/forever` see no discovery
   * hint and the command runs as a plain message detected by the supervisor.
   */
  "commands"
];

/** Loop config: continuation template + retry pacing. */
const Config = z.object({
  /**
   * Continuation prompt template (the default; a runtime override set from
   * the Settings → Endless loop page wins when present). Plain text;
   * supports `{{lastAnswer}}` (the concatenated assistant text of the
   * previous round), `{{round}}` (1-based; round 1 is the first
   * continuation, not the user's first message), and `{{task}}` (always
   * empty in web mode, kept for parity with the headless variant).
   * Unknown placeholders are left intact.
   */
  continuation: z.string().default("继续，并深度检查暗病，遇到暗病和缺陷就修复"),
  /** Initial backoff in milliseconds for the first failure-driven retry. */
  initialBackoffMs: z.number().step(1).min(1).max(60_000).default(1000),
  /**
   * Upper cap on the exponential backoff, in milliseconds. Once retries
   * hit this, every subsequent failure waits the cap before resending.
   */
  maxBackoffMs: z.number().step(1).min(1).max(600_000).default(32_000),
  /**
   * Multiplier applied to the backoff on each successive failure. 2 means
   * the standard 1s → 2s → 4s → 8s → 16s → 32s ladder; 1.5 slows growth.
   */
  backoffFactor: z.number().min(1).max(10).default(2),
  /**
   * If true, the loop only logs at warn / error level and stays silent on
   * a clean run. If false (default), it logs an info line per round
   * boundary so a long run leaves a visible trace in `dsh` logs.
   */
  quiet: z.boolean().default(false),
  /**
   * How old an agent's most recent durable event may be before the loop
   * treats it as an idle historical session. On attach (every dsh boot, the
   * supervisor picks up every restored session), an agent whose last event
   * is older than this window is NOT auto-continued — it waits for a fresh
   * user message instead, so a machine restart cannot set every old session
   * burning tokens at once. An agent with a recent exchange (the normal
   * "I just sent a message" case) is continued immediately. 0 disables the
   * guard entirely.
   */
  idleGraceMs: z.number().step(1).min(0).max(86_400_000).default(300_000),
  /**
   * Auto-answer mid-run questions. While the loop is enabled, a question
   * the agent asks through `ask_user_question` is answered automatically
   * instead of stalling the run on a human: the option marked recommended
   * (label suffix `(推荐)` / `(Recommended)`) wins, a `plan-review` intent
   * is approved, and a question without any marker falls back to its first
   * option. Only agents this plugin drives (loop on, driver armed) are
   * affected; interactive sessions keep asking normally.
   */
  autoAnswerQuestions: z.boolean().default(true),
  /**
   * Auto-answer free-text questions (an `ask_user_question` item with no
   * options) while the loop is enabled. A free-text question normally
   * parks the run on a human typing an answer; with this on, the run
   * instead answers with a standing "unattended — decide autonomously"
   * notice (never a fake human reply) so the agent records its assumption
   * and moves on. This is a deliberate autonomy grant: the model will act
   * on information nobody actually typed, so only enable it for runs you
   * are willing to let steer themselves. Off falls back to showing the
   * question to the human (the run parks until answered). Requires
   * `autoAnswerQuestions` to be on as well.
   */
  autoAnswerFreeText: z.boolean().default(true),
  /**
   * Auto-approve one-shot actions while the loop is enabled. A tool call
   * that asks for approval (sandbox escalation etc.) returns
   * `allowed-once` immediately for a driven agent, so the run never parks
   * on a `blocked` turn. The audit pair (`approval/asked` +
   * `approval/decided`) is still written, and a session whose policy is
   * `never` still rejects every ask before this hook runs. Non-driven
   * sessions keep the normal approval UI.
   */
  autoApproveActions: z.boolean().default(true),
  /**
   * After this many consecutive failures of the SAME retry prompt, the
   * retry stops resending the identical text and switches to an escalation
   * prompt: it tells the model the round has failed N times and carries the
   * latest error code + message, asking it to pursue a path that does not
   * depend on the failing operation (or to report the blocker and wrap up).
   * The run never gives up — escalation prompts keep coming (each carrying
   * the freshest error) until a turn completes, after which the failure
   * chain resets. 0 disables escalation entirely (pure identical resends,
   * the pre-escalation behavior). A prompt superseded by newer activity is
   * never resent and resets the chain, so interactive sessions do not
   * escalate.
   */
  escalateAfterFailures: z.number().step(1).min(0).max(100).default(3)
});

/**
 * Render a continuation template by substituting the supported placeholders.
 * Unknown placeholders are left intact so a typo is visible in the next
 * prompt rather than silently swallowed.
 * @param template - raw template string.
 * @param values - substitution values.
 * @returns the rendered string.
 */
function renderTemplate(template, values) {
  return template.replace(/\{\{(\w+)\}\}/g, (match, key) => {
    const value = values[key];
    if (typeof value === "string") return value;
    if (typeof value === "number" || typeof value === "boolean") return String(value);
    return match;
  });
}

/**
 * Label suffix the `ask_user_question` convention uses to mark the option
 * the model recommends: put it first and append `(Recommended)` — or the
 * Chinese `(推荐)` — to the label. The web UI strips this suffix for
 * display and shows a "推荐" chip instead; the matcher here mirrors the
 * UI's own parser (half-width or full-width parentheses, case-insensitive)
 * so auto-answer picks exactly what the human would have seen marked.
 */
const RECOMMENDED_SUFFIX = /\s*(?:\((?:recommended|推荐)\)|（(?:recommended|推荐)）)\s*$/i;

/** True when the label carries the recommended-option marker. */
function isRecommendedLabel(label) {
  return typeof label === "string" && RECOMMENDED_SUFFIX.test(label);
}

/** Remove the recommended marker so the answer carries the plain label. */
function stripRecommendedSuffix(label) {
  return typeof label === "string" ? label.replace(RECOMMENDED_SUFFIX, "").trim() : label;
}

/**
 * Standing answer given to a free-text question (an `ask_user_question`
 * item with no options) while unattended. It is deliberately NOT a fake
 * human reply: the model must not believe a person typed anything. It is
 * an autonomy grant — "no one is here to answer; make the call yourself,
 * state your assumption, and keep going". Rendered into the answer's
 * `custom` field, which the tool surfaces verbatim as the answer text.
 */
const FREE_TEXT_AUTO_ANSWER =
  "(无人值守自动应答) 当前循环无人值守，无法提供人工输入。请基于已有上下文与工具能力自行决策并继续；若缺少关键信息，先尝试通过工具获取，确实无法获取时明确说明你采用的假设后继续，不要停留在等待。";

/**
 * Decide automatic answers for a user-questions batch. Returns a fabricated
 * `{ answers }` payload (the exact shape `ctx.userQuestions.ask()` resolves
 * with), or null when the batch must go to a human.
 *
 * Per question the pick order is: (1) a `plan-review` intent's declared
 * `approve` option (that is the review's recommended action by
 * construction); (2) the first option whose label carries the
 * `(推荐)`/`(Recommended)` marker; (3) the first option, matching the
 * "recommended-first" convention even when the model forgot the marker.
 * A question with NO options is free text: with `answerFreeText` it is
 * answered with the standing autonomy-grant notice above (`selected` empty,
 * `custom` filled); without it the whole batch falls through to the human
 * rather than partially auto-answering.
 * @param questions - the questions the tool is asking.
 * @param options - { answerFreeText } controls free-text handling.
 * @returns an answer payload, or null when the batch must go to a human.
 */
function pickAutoAnswers(questions, { answerFreeText } = {}) {
  const answers = [];
  for (const question of questions) {
    const options = Array.isArray(question?.options) ? question.options : [];
    if (options.length === 0) {
      if (answerFreeText !== true) return null;
      answers.push({ id: question.id, selected: [], custom: FREE_TEXT_AUTO_ANSWER });
      continue;
    }
    let chosen = null;
    if (question?.intent?.kind === "plan-review" && typeof question.intent.approve === "string") {
      chosen = options.find((option) => option?.label === question.intent.approve) ?? null;
    }
    if (chosen === null) chosen = options.find((option) => isRecommendedLabel(option?.label)) ?? null;
    if (chosen === null) chosen = options[0];
    /* The option contract requires a `label`, but a malformed option must not
     * leak `selected: [undefined]` into the wire payload (it serializes as
     * `[null]` and the model sees a broken answer). Fall back to "" for a
     * label-less option rather than emitting undefined. */
    const label = typeof chosen?.label === "string" ? stripRecommendedSuffix(chosen.label) : "";
    answers.push({ id: question.id, selected: [label] });
  }
  return { answers };
}

/**
 * Render the escalation prompt sent once the SAME retry prompt has failed
 * `escalateAfterFailures` times. Instead of resending the identical text
 * (which keeps failing identically), the loop tells the model the round
 * keeps erroring and hands it the freshest error code + message so it can
 * route around the failing operation — or declare the blocker and wrap up.
 * The run never gives up: a failed escalation produces the next one with a
 * newer error, until a turn completes and the chain resets.
 * @param failures - how many times this prompt chain has failed in a row.
 * @param code - latest turn-error code ("unknown" when absent).
 * @param message - latest turn-error message, truncated.
 * @returns the escalation text to queue as the next user message.
 */
function renderEscalationPrompt(failures, code, message) {
  const summary = typeof message === "string" && message.length > 280 ? `${message.slice(0, 280)}…` : message;
  return (
    `(loop 无人值守自动升级) 你的上一条请求已经连续失败 ${failures} 次，` +
    `最近一次错误（${code}）：${summary ?? "(无详情)"}。` +
    `请不要再重发同一条注定失败的请求——换一条不依赖该失败操作的路径推进当前任务，` +
    `或先通过其他工具获取所需信息；若你判断任务确实无法继续推进，` +
    `请明确说明阻塞原因并结束本轮，不要无限重复同一个操作。`
  );
}

/**
 * Concatenate every assistant text block emitted between two seq boundaries
 * (inclusive of `fromSeq`, exclusive of `toSeq`) in the order they were
 * appended. Returns the empty string if the agent never produced any text
 * in that range.
 * @param events - the session's durable event log.
 * @param seq - first seq to consider.
 * @param toSeq - first seq to ignore.
 * @returns concatenated assistant text, or "".
 */
function collectAssistantText(events, fromSeq, toSeq) {
  let text = "";
  for (const event of events) {
    if (event.seq < fromSeq || event.seq >= toSeq) continue;
    if (event.type !== "assistant/message") continue;
    const blocks = Array.isArray(event.data?.message?.content) ? event.data.message.content : [];
    for (const block of blocks) if (block?.type === "text" && typeof block.text === "string") text += block.text;
  }
  return text;
}

/**
 * Find the seq of the last `turn/end` event in the range, or `null` if no
 * turn has ended yet. Used to bound the slice that becomes `lastAnswer`.
 * @param events - the session's durable event log.
 * @param fromSeq - first seq to consider.
 * @returns seq of the most recent turn/end, or null.
 */
function lastTurnEndSeq(events, fromSeq) {
  let seq = null;
  for (const event of events) {
    if (event.seq < fromSeq) continue;
    if (event.type === "turn/end") seq = event.seq;
  }
  return seq;
}

/**
 * Materialize the session's full event log, tolerating the dsh-session API
 * change across versions: older dsh (0.1.1) exposed `session.events` as a
 * frozen log array; dsh 0.1.5 removed that getter in favor of
 * `session.snapshotEvents(fromSeq, toSeqExclusive)`, whose no-argument call
 * returns the same full immutable snapshot (cached until the next append).
 * Prefer the method when present, fall back to the legacy property.
 * @param session - a live dsh Session.
 * @returns the session's durable event log, in seq order.
 */
function sessionEvents(session) {
  if (session != null && typeof session.snapshotEvents === "function") {
    return session.snapshotEvents();
  }
  return session?.events ?? [];
}

/**
 * Return the most recent `turn/end.data.reason` in a given seq range.
 * `reason.kind === "error"` is the signal the loop uses to drive retries.
 * @param events - the session's durable event log.
 * @param fromSeq - first seq to consider.
 * @returns the last `turn/end.data.reason` seen in range, or undefined.
 */
function lastTurnReason(events, fromSeq) {
  let reason;
  for (const event of events) {
    if (event.seq < fromSeq) continue;
    if (event.type === "turn/end") reason = event.data?.reason;
  }
  return reason;
}

/**
 * Whether a `turn/end` reason means the round finished productively and the
 * loop should queue the next continuation. `completed` is the normal end.
 * `max-tokens` also counts: the turn ended because the assistant hit its
 * output-token ceiling, but the assistant message was already persisted, so
 * the run must keep going (the model continues where it was cut off) — NOT
 * stall. Treating `max-tokens` as "wait" would leave the loop spinning once
 * a second forever on a truncated answer, which breaks the endless-loop
 * contract. Every other kind (`blocked` — a declined approval is waiting on
 * the human, `error`, `aborted`, `interrupted`, or any unknown plugin-added
 * kind) is not productive: the caller waits or retries instead.
 * @param reason - the `turn/end.data.reason` payload.
 * @returns true when the round produced a completed or token-capped answer.
 */
function isProductiveTurnEnd(reason) {
  return reason?.kind === "completed" || reason?.kind === "max-tokens";
}

/**
 * Whether this phase should queue the next continuation. A productive turn
 * end (`completed` / `max-tokens`) always drives. The one exception is a
 * /forever-armed driver's very first phase: the command system appends only
 * `command/run` + `command/done` for a slash command (never a `turn/end`),
 * so `reason` is `undefined` — but the user explicitly asked the loop to
 * start, so it must queue the first continuation (empty `{{lastAnswer}}`,
 * round 1) instead of waiting forever on a turn that will never arrive.
 * @param reason - the `turn/end.data.reason` payload (undefined when none).
 * @param skipWaitGuard - true when the driver was armed by /forever.
 * @param round - 0-based phase counter (0 = the driver's first phase).
 * @returns true when the loop should continue rather than wait.
 */
function shouldContinueAfterTurn(reason, skipWaitGuard, round) {
  if (isProductiveTurnEnd(reason)) return true;
  return skipWaitGuard === true && round === 0 && reason === undefined;
}

/**
 * Whether a `turn/end` reason means the user pressed stop during the turn.
 * `aborted` with `cause: "user"` is the only such signal; every other
 * abort cause (e.g. a superseded turn) is a runtime fault the loop retries.
 * @param reason - the `turn/end.data.reason` payload.
 * @returns true when the user manually stopped the turn.
 */
function isUserAbort(reason) {
  return reason?.kind === "aborted" && reason?.cause === "user";
}

/**
 * Whether a `turn/end` reason means the turn was cut short by a new user
 * message arriving mid-turn. The driver must NOT treat this as a failure:
 * the turn will settle (the new message gets its own turn), and the loop
 * resumes from there. Only `interrupted` with `cause: "user"` qualifies.
 * @param reason - the `turn/end.data.reason` payload.
 * @returns true when the turn was preempted by user input.
 */
function isUserInterrupt(reason) {
  return reason?.kind === "interrupted" && reason?.cause === "user";
}

/**
 * Compute the backoff delay for a given failure count, capped at the
 * configured maximum. The count is 1-based: the first failure uses
 * `initialBackoffMs`, the second `initialBackoffMs * backoffFactor`, etc.
 * @param failures - how many consecutive failures have occurred.
 * @param config - the loop config.
 * @returns the delay in milliseconds.
 */
function backoffMs(failures, config) {
  const raw = config.initialBackoffMs * Math.pow(config.backoffFactor, failures - 1);
  return Math.min(raw, config.maxBackoffMs);
}

/** Minimum interval between auto-compaction passes for the same agent. */
const AUTO_COMPACTION_COOLDOWN_MS = 5 * 60_000;

/** Detect a context-window-pressure error from its message / code. These
 * are the errors compaction exists to fix: the assembled history no longer
 * fits the model window. Retrying the same prompt without shrinking the
 * history fails identically forever, so the loop triggers a compaction
 * before the next retry. Matches provider-agnostic shapes (Anthropic's
 * "prompt is too long", OpenAI's "maximum context length", generic
 * "context length exceeded", token-count errors, and the raw
 * "Allocation error: not enough memory" surfaced by the host when the
 * assembled context exhausts process memory).
 * @param text - the error message, code, or combined diagnostic text.
 * @returns true when the error indicates the context window is the problem.
 */
function isContextPressureError(text) {
  if (typeof text !== "string") return false;
  const t = text.toLowerCase();
  return (
    /context.{0,30}(length|limit|exceed|overflow|too long|window|full)/.test(t) ||
    /(prompt|input|message).{0,20}(too long|exceed)/.test(t) ||
    /token.{0,30}(limit|exceed|too many|maximum|max)/.test(t) ||
    /(too many|maximum|max).{0,20}token/.test(t) ||
    /maximum.{0,20}(context|token|length)/.test(t) ||
    /allocation error|not enough memory|out of memory|array buffer allocation failed/.test(t)
  );
}

/**
 * Trigger one compaction for the agent's session through the host's
 * `ctx.compaction.compactNow` seam — the exact API the `/compact` command
 * uses. Fire-and-forget from the driver's perspective: any failure (the
 * service is absent, the agent is busy, the history is not compactable,
 * the summary could not be produced, ...) is logged and swallowed, and the
 * loop simply retries on its own. Rate-limited to one pass per
 * AUTO_COMPACTION_COOLDOWN_MS so a context-bounded loop does not hammer
 * compaction every backoff cycle.
 * @param state - per-agent loop state (carries `lastCompactAt`).
 * @param agent - the agent being driven.
 * @param compaction - the host compaction service, or null when absent.
 * @param logger - host logger.
 * @returns true when a compaction actually ran, false otherwise.
 */
async function tryAutoCompact(state, agent, compaction, logger) {
  if (!compaction || typeof compaction.compactNow !== "function") return false;
  if (state.lastCompactAt && Date.now() - state.lastCompactAt < AUTO_COMPACTION_COOLDOWN_MS) {
    logger?.warn?.(`dsh-loop-agent: context pressure on agent "${agent.id}" but auto-compaction cooling down; retrying without compacting`);
    return false;
  }
  try {
    logger?.warn?.(`dsh-loop-agent: context pressure on agent "${agent.id}"; triggering compaction before retry`);
    const result = await compaction.compactNow(agent, state.abort.signal, "dsh-loop-agent-auto");
    state.lastCompactAt = Date.now();
    if (result === null) {
      logger?.warn?.(`dsh-loop-agent: compaction for agent "${agent.id}" had no compactable history; retrying without compacting`);
      return false;
    }
    logger?.warn?.(`dsh-loop-agent: compaction for agent "${agent.id}" shadowed ${result.shadowedSeqs?.length ?? 0} items (~${result.shadowedTokenCount ?? 0} tokens); retrying`);
    return true;
  } catch (error) {
    if (state.abort.signal.aborted) return false;
    logger?.warn?.(`dsh-loop-agent: compaction for agent "${agent.id}" failed (${error instanceof Error ? error.message : String(error)}); retrying without compacting`);
    return false;
  }
}

/**
 * Return the text of the last real `user/message` event in a given seq
 * range, or null when none exists. The loop's own followups are
 * user-sourced messages too (`source.kind: "user"`), so this finds whatever
 * prompt led into a turn — a real user question on round 0, or a queued
 * continuation on later rounds. Events dsh injected onto the user channel
 * (`source.kind: "plugin"` — runtime-context snapshots, skill reminders)
 * are skipped: replaying them as a "retry prompt" would resend platform
 * scaffolding instead of the message that actually failed.
 * @param events - the session's durable event log.
 * @param fromSeq - first seq to consider.
 * @param toSeq - first seq to ignore.
 * @returns the last real user message text in range, or null.
 */
function lastUserMessageText(events, fromSeq, toSeq) {
  let text = null;
  for (const event of events) {
    if (event.seq < fromSeq || event.seq >= toSeq) continue;
    if (event.type !== "user/message") continue;
    if (event.data?.source?.kind === "plugin") continue;
    // dsh-session's deriveEventMessage returns `event.data` itself for
    // `user/message` (no `.message` wrapper — unlike `assistant/message`),
    // so the text blocks live at `event.data.content` directly.
    const blocks = Array.isArray(event.data?.content) ? event.data.content : [];
    let combined = "";
    for (const block of blocks) if (block?.type === "text" && typeof block.text === "string") combined += block.text;
    if (combined !== "") text = combined;
  }
  return text;
}

/**
 * Return true when the durable log contains at least one delivered real user
 * message. The loop uses this to distinguish "agent never started" from
 * "agent answered and is idle": a brand-new agent has no user message and
 * no completed turn, and queueing a continuation into it would race the
 * user's first message. Messages dsh injected onto the user channel
 * (`source.kind: "plugin"` — runtime-context snapshots, skill reminders,
 * file-change notices, inter-agent relays) do NOT count: a fresh agent that
 * only received injected scaffolding has not been spoken to, and driving it
 * into an endless run would hijack a conversation no human started. The
 * loop's own followups are `source.kind: "user"` and still count, matching
 * `lastUserMessageText`.
 * @param events - the session's durable event log.
 * @returns true when a real user message exists anywhere in the log.
 */
function hasUserMessage(events) {
  for (const event of events) {
    if (event.type !== "user/message") continue;
    if (event.data?.source?.kind === "plugin") continue;
    return true;
  }
  return false;
}

/**
 * Seed the driver's initial round boundary from a session's pre-existing
 * durable log. A freshly attached driver (supervisor attach, profile
 * restart, or re-enable after a stop-button halt) must not treat events from
 * before its birth as its own current round:
 *
 * 1. Trailing turn/end events that ended `aborted` or `interrupted` — the
 *    durable remnants of a user clicking stop or a crash-orphaned turn —
 *    are consumed by the boundary, so a re-enabled loop does not
 *    immediately re-halt on a stop that predates this driver.
 * 2. Otherwise the boundary starts at the SECOND-TO-LAST "drivable" turn/end
 *    (completed / error / blocked / max-tokens), so the first phase consumes
 *    exactly the last finished round as round 1 — `{{lastAnswer}}` holds one
 *    round's text, not the entire transcript of a long-running session.
 * 3. With fewer than two drivable turn/ends the boundary stays 0; the whole
 *    (single-round or empty) history IS that first round's domain.
 *
 * @param events - the session's durable event log.
 * @returns the lastRoundEndSeq value to start the driver with.
 */
function seedInitialBoundary(events) {
  /* One past the last stale (aborted/interrupted) turn/end, so those turns
   * never drive the first phase. */
  let stalePast = 0;
  /* Seqs of turn/ends that can legitimately drive a round. */
  const drivable = [];
  for (const event of events) {
    if (event.type !== "turn/end") continue;
    const kind = event.data?.reason?.kind;
    if (kind === "aborted" || kind === "interrupted") {
      stalePast = event.seq + 1;
    } else {
      drivable.push(event.seq);
    }
  }
  if (drivable.length >= 2) return Math.max(stalePast, drivable[drivable.length - 2]);
  if (drivable.length === 1) return Math.max(stalePast, 0);
  return stalePast;
}

/**
 * Return true when any user-sourced activity with seq >= fromSeq exists —
 * a `user/message` (the durable echo of a delivered message) or an
 * `agent/inbox/spliced` (a message queued into the agent's inbox, which
 * lands before its turn/start). The retry branch uses this to treat a
 * user interjection that happened during the backoff as superseding the
 * stale errored prompt — even while the user's own turn is still running
 * and has not produced a new `turn/end` yet. Resending the retry into that
 * gap would queue a ghost replay behind the user's live turn.
 * @param events - the session's durable event log.
 * @param fromSeq - first seq to consider.
 * @returns true when newer user-sourced activity exists.
 */
function hasNewerUserActivity(events, fromSeq) {
  for (const event of events) {
    if (event.seq < fromSeq) continue;
    // `user/message` is the durable echo of a delivered message. Filter
    // plugin-injected ones (source.kind === "plugin" — runtime snapshots,
    // skill reminders) so they do not masquerade as a real user interjection
    // and skip a legitimate retry. Mirrors the same filter in hasUserMessage.
    if (event.type === "user/message") {
      if (event.data?.source?.kind !== "plugin") return true;
      continue;
    }
    // `agent/inbox/spliced` fires when a message is queued into the agent's
    // inbox (followup / steer / inject). The event's `data.inserted` entries
    // carry source.kind when available; a splice with only plugin-injected
    // entries is not real user activity (inject() with wakeup=false does not
    // wake the driver, so treating it as such would skip a legitimate retry).
    // A splice from followup/steer (real user input) has no source.kind or a
    // non-plugin one — treat that as real activity. When the data shape is
    // ambiguous (no inserted array, empty array) fall back to counting it
    // as activity to avoid silently dropping a real user interjection.
    if (event.type === "agent/inbox/spliced") {
      const inserted = event.data?.inserted;
      if (!Array.isArray(inserted) || inserted.length === 0) return true;
      if (inserted.some((m) => m?.source?.kind !== "plugin")) return true;
      continue;
    }
  }
  return false;
}

/**
 * Return the wall-clock time (epoch ms) of the most recent durable event,
 * or 0 for an empty log. Used by the idle-grace guard to tell a freshly
 * active agent (boot it and keep going) from a stale restored session
 * (wait for the user to speak first).
 * @param events - the session's durable event log.
 * @returns epoch ms of the last event, or 0 when the log is empty.
 */
function lastEventTime(events) {
  const last = events.at(-1);
  return typeof last?.time === "number" ? last.time : 0;
}

/**
 * The command a user types in a halted session to re-arm the endless loop
 * for that conversation. Lowercase, leading slash; trimmed leading/trailing
 * whitespace is ignored. Anything starting with this token (case-insensitive)
 * counts — so `/forever` and `/forever now please` both re-arm.
 */
const FOREVER_COMMAND = "/forever";

/**
 * True when the given text is (or starts with) the /forever re-arm command.
 * Case-insensitive; leading/trailing whitespace is stripped.
 * @param text - the user message text.
 * @returns true when the text triggers the re-arm.
 */
function isForeverCommand(text) {
  if (typeof text !== "string") return false;
  return text.trim().toLowerCase().startsWith(FOREVER_COMMAND);
}

/**
 * A per-agent loop state. Owns the driver task, the abort signal, and the
 * round boundary bookkeeping. One instance per live agent; created by the
 * supervisor on attach, deleted when the agent leaves the registry or the
 * user stops the run.
 */
class LoopState {
  /**
   * @param agent - the dsh Agent this state drives.
   * @param config - the loop config.
   * @param profile - the profile name (for the sidecar file).
   * @param options - { armedByForever } marks a state created by /forever.
   */
  constructor(agent, config, profile, { armedByForever = false } = {}) {
    this.agent = agent;
    this.config = config;
    this.profile = profile;
    this.armedByForever = armedByForever;
    this.disarmed = false;
    this.haltedByUser = false;
    this.subagent = false;
    this.haltAtSeq = 0;
    this.round = 0;
    this.consecutiveFailures = 0;
    this.retryChainFailures = 0;
    this.lastRetryPrompt = null;
    this.abort = new AbortController();
    this.driver = null;
  }

  /**
   * Disarm the state: abort the in-flight driver and mark it as no longer
   * driving. Called when the user stops the run, the agent leaves the
   * registry, or the plugin is torn down.
   */
  disarm() {
    if (this.disarmed) return;
    this.disarmed = true;
    this.abort.abort();
    if (this.driver) {
      this.driver = null;
    }
  }
}

/**
 * Install the user-questions provider wrap for dsh 0.1.1 (legacy). On
 * 0.1.5+ the `user-questions/request` waterfall is used instead, and this
 * is a no-op. The wrap intercepts `ask()` calls and auto-answers questions
 * from armed loop agents.
 */
function installQuestionAutoAnswer() {
  try {
    const uq = ctx.get?.("userQuestions");
    if (!uq || typeof uq?.provider?.ask !== "function") return;
    if (uq.provider.__loopAgentWrapped) return;
    const original = uq.provider.ask.bind(uq.provider);
    uq.provider.ask = async function (questions, options) {
      const agent = options?.agent;
      if (config.autoAnswerQuestions !== false && drivenAndArmed(agent)) {
        const auto = pickAutoAnswers(questions, { answerFreeText: config.autoAnswerFreeText !== false });
        if (auto !== null) {
          logger?.info?.(`dsh-loop-agent: agent "${agent.id}" ask auto-answered (${auto.answers.length} question(s)) via provider wrap`);
          return auto;
        }
      }
      return original(questions, options);
    };
    uq.provider.__loopAgentWrapped = true;
  } catch {
    // Service not available yet; the supervisor retries every tick.
  }
}

/**
 * Uninstall the user-questions provider wrap. Called on plugin teardown.
 */
function uninstallQuestionAutoAnswer() {
  try {
    const uq = ctx.get?.("userQuestions");
    if (!uq?.provider?.__loopAgentWrapped) return;
    delete uq.provider.__loopAgentWrapped;
    // The original ask is not stored; the wrap is idempotent and the
    // service is torn down with the plugin anyway.
  } catch {
    // Ignore teardown errors.
  }
}

/**
 * Whether an agent is currently driven by the loop (armed and not halted).
 * @param agent - the agent to check.
 * @returns true when the agent has an armed loop state.
 */
function drivenAndArmed(agent) {
  if (!agent) return false;
  const state = states.get(agent);
  return state !== undefined && !state.disarmed && !state.haltedByUser;
}

/**
 * Read the current snapshot of the loop state for the settings panel.
 * @param profile - the profile name.
 * @returns { enabled, continuation, defaultContinuation, attachedAgents, version }
 */
function readSnapshot(profile = "web") {
  const disabled = readDisabled(profile);
  const override = readContinuationOverride(profile);
  const attached = [...states.values()].filter((s) => !s.disarmed && !s.haltedByUser).length;
  return {
    enabled: !disabled,
    continuation: override ?? "",
    defaultContinuation: Config.shape.continuation.value,
    attachedAgents: attached,
    version: BUNDLE_VERSION
  };
}

/**
 * Read and parse a JSON request body, or null on error (the response
 * has already been written).
 * @param req - the incoming HTTP request.
 * @param res - the outgoing HTTP response.
 * @returns the parsed body, or null on error.
 */
async function readJsonBody(req, res) {
  try {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString("utf8");
    return raw ? JSON.parse(raw) : {};
  } catch {
    sendJson(res, 400, { error: "invalid JSON body" });
    return null;
  }
}

/**
 * Send a JSON response with the given status code.
 * @param res - the outgoing HTTP response.
 * @param status - the HTTP status code.
 * @param body - the response body object.
 */
function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(payload);
}

/**
 * The main driver loop for one agent. Runs forever until the state is
   * disarmed. Each iteration waits for the agent to go idle, then queues
   * the next continuation prompt.
 * @param state - the per-agent loop state.
 * @param logger - the plugin logger.
 * @param compactionService - the compaction service (or null).
 */
async function driveLoop(state, logger, compactionService) {
  const { agent, config, profile } = state;
  while (!state.disarmed) {
    // Wait for the agent to go idle (no in-flight turn).
    try {
      await agent.whenIdle();
    } catch (error) {
      if (state.disarmed) return;
      logger?.warn?.(`dsh-loop-agent: whenIdle threw for agent "${agent.id}": ${error instanceof Error ? error.message : String(error)}; backing off`);
      await new Promise((r) => setTimeout(r, backoffMs(state.consecutiveFailures + 1, config)));
      continue;
    }
    if (state.disarmed) return;

    // Check if the loop is still enabled.
    if (readDisabled(profile)) {
      state.haltedByUser = true;
      state.disarm();
      return;
    }

    // Check if the session was archived.
    const archived = sessionArchivedSet();
    if (archived?.has(agent.session?.id)) {
      state.haltedByUser = true;
      state.disarm();
      return;
    }

    // Determine the continuation prompt.
    const override = readContinuationOverride(profile);
    const template = override ?? config.continuation;
    const events = sessionEvents(agent.session);
    const fromSeq = state.haltAtSeq || 0;
    const toSeq = agent.session?.seq ?? events.length;
    const lastAnswer = collectAssistantText(events, fromSeq, toSeq);
    const round = ++state.round;
    const prompt = renderTemplate(template, { lastAnswer, round, task: "" });

    // Queue the continuation as a user message.
    try {
      const msg = createUserMessage(prompt);
      await agent.enqueue(msg);
      state.haltAtSeq = toSeq;
      state.consecutiveFailures = 0;
      state.retryChainFailures = 0;
      state.lastRetryPrompt = null;
      logger?.info?.(`dsh-loop-agent: agent "${agent.id}" round ${round} queued (${lastAnswer.length} chars of assistant text consumed)`);
    } catch (error) {
      if (state.disarmed) return;
      state.consecutiveFailures++;
      const code = error instanceof Error ? error.name : "unknown";
      const message = error instanceof Error ? error.message : String(error);
      logger?.warn?.(`dsh-loop-agent: turn error on agent "${agent.id}" (code=${code}): ${message}; backing off, then retrying the same prompt`);

      // Escalation: after N identical failures, switch to an escalation prompt.
      if (state.lastRetryPrompt === prompt) {
        state.retryChainFailures++;
      } else {
        state.retryChainFailures = 1;
        state.lastRetryPrompt = prompt;
      }
      if (config.escalateAfterFailures > 0 && state.retryChainFailures >= config.escalateAfterFailures) {
        const escalation = renderEscalationPrompt(state.retryChainFailures, code, message);
        logger?.info?.(`dsh-loop-agent: agent "${agent.id}" retrying round after backoff — ESCALATED (${state.retryChainFailures} identical failures; route-around prompt sent)`);
        try {
          const msg = createUserMessage(escalation);
          await agent.enqueue(msg);
        } catch {
          // The retry enqueue failed too; the next phase will retry again.
        }
      } else {
        logger?.info?.(`dsh-loop-agent: agent "${agent.id}" retrying round after backoff (${state.retryChainFailures} identical failure(s) so far)`);
        try {
          const msg = createUserMessage(prompt);
          await agent.enqueue(msg);
        } catch {
          // The retry enqueue failed too; the next phase will retry again.
        }
      }

      await new Promise((r) => setTimeout(r, backoffMs(state.consecutiveFailures, config)));
    }
  }
}

/**
 * The plugin apply step. Registers the webserver routes, the /forever
   * command, the auto-approve and auto-answer hooks, and starts the
   * attachment supervisor.
 * @param ctx - the Cordis context.
 */
function apply(ctx) {
  const profile = "web";
  const config = Config.parse({});
  const logger = ctx.logger;

  // Map of agent -> LoopState for all known agents.
  const states = new Map();
  // Set of agent IDs armed by /forever, pending supervisor pickup.
  const armedAgentIds = new Map();

  // Get the compaction service (optional).
  let compactionService = null;
  try {
    compactionService = ctx.get?.("compaction");
  } catch {
    // Compaction not available; the loop still works without it.
  }

  // Register webserver routes for the settings panel.
  const STATE_PATH = "/api/loop-agent/state";
  const ENABLED_PATH = "/api/loop-agent/enabled";
  const CONTINUATION_PATH = "/api/loop-agent/continuation";

  ctx.effect(() => ctx.webServer.register({
    kind: "exact",
    path: STATE_PATH,
    handler: async (req, res) => {
      if (req.method !== "GET") {
        res.writeHead(405, { allow: "GET" });
        res.end();
        return;
      }
      sendJson(res, 200, readSnapshot(profile));
    }
  }), "dsh-loop-agent: GET /api/loop-agent/state");

  ctx.effect(() => ctx.webServer.register({
    kind: "exact",
    path: ENABLED_PATH,
    handler: async (req, res) => {
      if (req.method !== "POST") {
        res.writeHead(405, { allow: "POST" });
        res.end();
        return;
      }
      const body = await readJsonBody(req, res);
      if (body === null) return;
      if (typeof body?.enabled !== "boolean") {
        sendJson(res, 400, { error: "enabled must be a boolean" });
        return;
      }
      const result = writeDisabled(!body.enabled, profile);
      logger?.info?.(`dsh-loop-agent: endless loop ${body.enabled ? "enabled" : "disabled"}; takes effect within seconds (sidecar ${result.path})`);
      if (body.enabled) {
        logger?.info?.(`dsh-loop-agent: loop enabled; type /forever in a session to activate its endless run`);
      } else {
        // Halt all running loops.
        let haltedCount = 0;
        for (const [agent, state] of [...states]) {
          if (state.disarmed || state.haltedByUser) continue;
          state.haltAtSeq = agent.session?.seq ?? sessionEvents(agent.session).length;
          state.haltedByUser = true;
          state.disarm();
          try {
            agent.cancel?.({ kind: "user" });
          } catch (error) {
            logger?.warn?.(`dsh-loop-agent: cancel on agent "${agent.id}" during global disable failed: ${error instanceof Error ? error.message : String(error)}`);
          }
          haltedCount++;
          logger?.info?.(`dsh-loop-agent: agent "${agent.id}" halted by global disable`);
        }
        if (haltedCount > 0) {
          logger?.info?.(`dsh-loop-agent: ${haltedCount} agent(s) halted by global disable; type /forever in each session to re-arm after re-enabling`);
        }
      }
      sendJson(res, 200, {
        ...readSnapshot(profile),
        path: result.path,
        changed: result.changed
      });
    }
  }), "dsh-loop-agent: POST /api/loop-agent/enabled");

  ctx.effect(() => ctx.webServer.register({
    kind: "exact",
    path: CONTINUATION_PATH,
    handler: async (req, res) => {
      if (req.method !== "POST") {
        res.writeHead(405, { allow: "POST" });
        res.end();
        return;
      }
      const body = await readJsonBody(req, res);
      if (body === null) return;
      if (typeof body?.continuation !== "string") {
        sendJson(res, 400, { error: "continuation must be a string" });
        return;
      }
      const cleared = body.continuation.trim() === "";
      const result = writeContinuation(body.continuation, profile);
      logger?.info?.(`dsh-loop-agent: continuation ${cleared ? "reset to the config default" : "override saved"}; takes effect on the next round (sidecar ${result.path})`);
      sendJson(res, 200, {
        ...readSnapshot(profile),
        path: result.path,
        changed: result.changed
      });
    }
  }), "dsh-loop-agent: POST /api/loop-agent/continuation");

  /* Register /forever as a slash command so the UI input box shows it in
   * autocomplete discovery. The handler directly arms the agent instead of
   * relying on the supervisor to scan for the message, because the command
   * system intercepts slash commands and only emits command/run and
   * command/done events (not user/message events). */
  ctx.effect(() => ctx.commands.register({
    name: "forever",
    description: "Activate the endless loop for this session",
    handler: async (invocation) => {
      try {
        const agent = invocation?.agent;
        if (!agent) {
          logger?.warn?.(`dsh-loop-agent: /forever ignored — no agent in invocation`);
          return { kind: "error", text: "No agent context for this command." };
        }
        
        const agentId = agent.id;
        
        if (readDisabled(profile)) {
          logger?.warn?.(`dsh-loop-agent: /forever ignored for agent "${agentId}" — loop is disabled`);
          return { kind: "error", text: "Endless loop is disabled. Enable it in Settings → Endless loop first." };
        }
        
        // Check if it's archived
        const archived = sessionArchivedSet();
        if (archived?.has(agent.session?.id)) {
          logger?.warn?.(`dsh-loop-agent: /forever ignored for agent "${agentId}" — session is archived`);
          return { kind: "error", text: "Cannot activate endless loop for an archived session." };
        }
        
        // Find or create the state for this agent
        let state = states.get(agent);
        if (!state) {
          // Race condition: supervisor hasn't seen this agent yet.
          // Create a parked state now so we can arm it.
          state = new LoopState(agent, config, profile);
          state.haltAtSeq = agent.session?.seq ?? sessionEvents(agent.session).length; // Only scan NEW messages
          state.haltedByUser = true;
          state.disarm();
          states.set(agent, state);
          logger?.info?.(`dsh-loop-agent: agent "${agentId}" created parked state on-demand for /forever command`);
        }
        
        // Check if it's already armed
        if (!state.haltedByUser) {
          logger?.info?.(`dsh-loop-agent: /forever ignored for agent "${agentId}" — already armed`);
          return { kind: "success", text: "Endless loop is already active for this session." };
        }
        
        // Arm the agent: disarm the halted state and mark for re-arming
        state.disarm();
        states.delete(agent);
        
        // Skip past the /forever message itself
        const seq = agent.session?.seq ?? sessionEvents(agent.session).length;
        armedAgentIds.set(agentId, seq);
        
        logger?.info?.(`dsh-loop-agent: /forever command armed for agent "${agentId}" (seq=${seq}); supervisor will start driver on next tick`);
        return { kind: "success", text: "Endless loop activated for this session. Driver will start within 1 second." };
      } catch (error) {
        logger?.error?.(`dsh-loop-agent: /forever command handler failed: ${error instanceof Error ? error.message : String(error)}`);
        return { kind: "error", text: `Failed to activate endless loop: ${error instanceof Error ? error.message : String(error)}` };
      }
    }
  }), "dsh-loop-agent: /forever command registration");

  /**
   * Snapshot of the workspace registry's archive set — session ids the user
   * archived in the UI. Archiving hides a session from every grouping
   * surface WITHOUT disposing its agent or session (see `dsh-workspace`:
   * `archiveSession` only appends to the durable `archivedSessionIds`), so
   * without this check the endless loop would keep burning tokens on a
   * hidden conversation. Returns a Set of archived ids, or null when the
   * registry is absent or not yet bootstrapped (the web profile always
   * mounts it; degrade to a no-op elsewhere rather than throw). The archive
   * list is polled, matching the supervisor's polling design — there is no
   * root-visible archive event a third-party plugin could subscribe to.
   */
  function sessionArchivedSet() {
    try {
      const registry = ctx.get?.("workspaceRegistry");
      const ids = registry?.archivedSessionIds;
      return Array.isArray(ids) ? new Set(ids) : null;
    } catch {
      return null;
    }
  }

  /* Auto-grant one-shot approvals for armed loop agents. `prepend` makes
   * this handler run before the web api-proxy's own `approval/request`
   * handler regardless of plugin load order, so a driven agent's approval
   * resolves here and never reaches the browser card; every other request
   * calls `next()` and keeps the normal chain. */
  ctx.effect(() => {
    const disposer = ctx.on("approval/request", (req, next) => {
      const agent = req?.agent;
      if (config.autoApproveActions === false || !drivenAndArmed(agent)) return next();
      logger?.info?.(`dsh-loop-agent: agent "${agent.id}" ${req?.toolName ?? "action"} auto-approved (allowed-once)`);
      return Promise.resolve("allowed-once");
    }, { prepend: true });
    return disposer;
  }, "dsh-loop-agent: auto-approve for armed loop agents");

  /* Auto-answer mid-run questions for armed loop agents (dsh 0.1.5+).
   * The user-questions service no longer carries a single `.provider.ask`
   * function: `ctx.userQuestions.ask()` dispatches through the
   * `user-questions/request` waterfall (scoped to the asking agent), so the
   * answerer is a `prepend` handler exactly like the approval one. An armed
   * loop agent's question resolves here and never reaches the browser card;
   * every other request calls `next()`. The legacy `.provider` wrap below
   * remains for dsh 0.1.1, whose service still exposes a wrap-able `ask`.
   * The two seams are mutually exclusive by host generation — the waterfall
   * is never triggered on 0.1.1, and `.provider` is undefined on 0.1.5. */
  ctx.effect(() => {
    const disposer = ctx.on("user-questions/request", (request, next) => {
      const agent = request?.agent;
      if (config.autoAnswerQuestions === false || !drivenAndArmed(agent) || !Array.isArray(request?.questions)) {
        return next();
      }
      const auto = pickAutoAnswers(request.questions, { answerFreeText: config.autoAnswerFreeText !== false });
      if (auto === null) return next();
      logger?.info?.(`dsh-loop-agent: agent "${agent.id}" ask auto-answered (${auto.answers.length} question(s)) via waterfall`);
      return Promise.resolve(auto);
    }, { prepend: true });
    return disposer;
  }, "dsh-loop-agent: auto-answer questions for armed loop agents");

  /* Patch the user-questions provider now (the api-proxy usually applied
   * before this bundle row), and restore it if the plugin is torn down. */
  installQuestionAutoAnswer();
  ctx.effect(() => () => {
    uninstallQuestionAutoAnswer();
  }, "dsh-loop-agent: restore wrapped user-questions provider");

  /*
   * Attachment supervisor.
   *
   * `agent/created`, `agent/disposed` and `session/disposed` are all
   * scope-filtered events (`this: Scoped<Agent>`): they dispatch only to
   * listeners registered inside that agent's own scope chain, never to a
   * plugin sitting on the root context. The official agent-loop plugin can
   * rely on them only because it IS the agent factory and registers inside
   * each agent's scope. A third-party host plugin has no such hook, so the
   * only reliable way to discover agents is to poll the public registry
   * (`ctx.agents.list()` / `.roots()`), which every live agent populates on
   * the same context regardless of scope.
   *
   * The supervisor polls once a second, attaches a driver to every top-level
   * (root) agent it has not seen yet, and disarms drivers whose agent has
   * left the root set (the poll replaces the never-delivered `agent/disposed`
   * signal for root agents; subagents never get a driver so they never
   * appear in the state map). The same tick consults the workspace archive
   * set: an agent whose session is archived never gets a driver (and a
   * running driver whose session just got archived is halted and its
   * in-flight work cancelled), so archiving a conversation stops its endless
   * run within a second even though the agent stays alive underneath.
   * Attachment itself is cheap: `driveLoop` sits at the disabled gate when
   * the loop is off, and waits on `whenIdle()` when it is on, so attaching
   * to an already-idle agent queues the next continuation immediately.
   */
  ctx.effect(() => {
    let tornDown = false;
    const timer = setInterval(() => {
      if (tornDown) return;
      /* (Re)wrap the user-questions provider: the web api-proxy registers a
       * fresh provider object on each of its applies, so a re-registration
       * since the last tick would otherwise silently drop the auto-answer
       * patch. Cheap — a WeakSet membership check when already wrapped. */
      installQuestionAutoAnswer();
      /* Top-level (root) agents only: subagents (anything spawned under a
       * parent owner context — dsh-subagent, in-agent helpers, ...) are
       * scoped, ephemeral helpers, not conversations the user opens in the
       * message list, and the loop default is to leave them alone (no
       * driver, no auto-answer, no auto-approve). Counting them in
       * "attached agents" would inflate the number, and attaching a driver
       * would burn tokens on a hidden session. `ctx.agents.roots()` is the
       * same registry, filtered to entries with no owner — exactly the
       * top-level conversations the user sees. */
      let live = [];
      try {
        live = ctx.agents.roots();
      } catch (error) {
        logger?.warn?.(`dsh-loop-agent: registry poll failed: ${error instanceof Error ? error.message : String(error)}`);
        return;
      }
      const liveSet = new Set(live);
      const archived = sessionArchivedSet();

      /* /forever re-arm sweep: a user who halted a conversation with the
       * stop button can type `/forever` in that session to re-arm the
       * endless loop for it. Only applies while the global switch is on —
       * a disabled loop never re-arms, even on /forever. Archived sessions
       * are exempt (the user cannot type into a hidden session, and even
       * if the /forever message was delivered before the archive landed,
       * we honor the archive as the most recent intent). */
      if (!readDisabled(profile)) {
        for (const [agent, state] of [...states]) {
          if (!state.haltedByUser) continue;
          if (state.subagent) continue;
          if (archived?.has(agent.session?.id)) continue;
          const events = sessionEvents(agent.session);
          if (!Array.isArray(events)) continue;
          const fromSeq = state.haltAtSeq || 0;
          for (const event of events) {
            if (event.seq < fromSeq) continue;
            if (event.type !== "user/message") continue;
            if (event.data?.source?.kind === "plugin") continue;
            const blocks = Array.isArray(event.data?.content) ? event.data.content : [];
            let text = "";
            for (const block of blocks) if (block?.type === "text" && typeof block.text === "string") text += block.text;
            if (isForeverCommand(text)) {
              // Disarm the old halted state
              state.disarm();
              // Delete from states so next tick re-attaches as armed
              states.delete(agent);
              // Mark as armed with the seq after /forever message
              armedAgentIds.set(agent.id, event.seq + 1);
              logger?.info?.(`dsh-loop-agent: agent "${agent.id}" marked for re-arming by /forever command (seq=${event.seq + 1})`);
              break;
            }
          }
        }
      }

      for (const agent of live) {
        if (states.has(agent)) continue;
        if (archived?.has(agent.session?.id)) {
          /* Archived session: never start a driver. Park a halted state so
           * the supervisor does not reconsider it every tick; re-arm only
           * happens after the user unarchives AND types /forever. */
          const state = new LoopState(agent, config, profile);
          state.haltAtSeq = agent.session?.seq ?? sessionEvents(agent.session).length;
          state.haltedByUser = true;
          state.disarm();
          states.set(agent, state);
          logger?.info?.(`dsh-loop-agent: agent "${agent.id}" is archived; loop not attached`);
          continue;
        }
        /* On-demand mode: do NOT auto-attach drivers to new agents. Instead,
         * park them in a halted state and wait for the user to type /forever
         * in that session. The /forever sweep above will detect the command
         * and arm the driver. Skip agents in armedAgentIds (already armed by
         * /forever command). This gives users explicit control: no session runs
         * until they opt in with /forever. */
        if (armedAgentIds.has(agent.id)) {
          const seq = armedAgentIds.get(agent.id);
          armedAgentIds.delete(agent.id);
          // Create armed state and start driver
          const state = new LoopState(agent, config, profile, { armedByForever: true });
          state.haltAtSeq = seq; // Skip past the /forever message
          states.set(agent, state);
          logger?.info?.(`dsh-loop-agent: agent "${agent.id}" armed by /forever; starting driver`);
          driveLoop(state, logger, compactionService).catch((error) => {
            /* Absolute last-resort fault barrier. driveLoop's own outer
             * try/catch converts every driver fault into a backoff retry,
             * so reaching this .catch means something catastrophic escaped
             * it (e.g. the driver fault handler itself threw). Never
             * terminate the endless run here: keep the state alive and
             * re-queue a fresh driver after a backoff instead of
             * disarm + delete. Only a genuinely disarmed state (user stop /
             * archive / agent teardown) stops the run. */
            logger?.warn?.(`dsh-loop-agent: driver task for armed agent "${agent.id}" rejected: ${error instanceof Error ? error.message : String(error)}; re-queuing driver`);
            if (state.disarmed) return;
            const requeue = () => {
              if (state.disarmed || !states.has(agent)) return;
              logger?.warn?.(`dsh-loop-agent: re-queuing driver for agent "${agent.id}"`);
              driveLoop(state, logger, compactionService).catch(() => {
                /* The re-queued driver carries the same outer fault barrier;
                 * if it rejects too, the next supervisor tick's park-or-arm
                 * sweep sees a live agent and re-attaches. Swallow to avoid
                 * an unhandled rejection storm. */
              });
            };
            setTimeout(requeue, backoffMs(state.consecutiveFailures + 1, config));
          });
          continue;
        }
        const state = new LoopState(agent, config, profile);
        state.haltAtSeq = agent.session?.seq ?? sessionEvents(agent.session).length; // Only scan NEW messages, not history
        state.haltedByUser = true;
        state.disarm();
        states.set(agent, state);
        logger?.debug?.(`dsh-loop-agent: agent "${agent.id}" parked; type /forever to activate endless loop`);
      }
      for (const [agent, state] of [...states]) {
        if (!liveSet.has(agent)) {
          state.disarm();
          states.delete(agent);
          // Clean up armedAgentIds to prevent memory leak when agent leaves
          // before supervisor processes the armed state
          armedAgentIds.delete(agent.id);
          logger?.info?.(`dsh-loop-agent: agent "${agent.id}" left registry (no longer a root); loop wound down`);
          continue;
        }
        if (!state.disarmed && archived?.has(agent.session?.id)) {
          /* The conversation was archived while its loop was running.
           * Disarm the driver and cancel whatever the agent is doing
           * (drops any queued continuation and aborts the in-flight turn;
           * a no-op when idle) so an archived session stops spending
           * immediately instead of finishing the current auto-reply. */
          state.haltAtSeq = agent.session?.seq ?? sessionEvents(agent.session).length;
          state.haltedByUser = true;
          state.disarm();
          try {
            agent.cancel?.({ kind: "user" });
          } catch (error) {
            logger?.warn?.(`dsh-loop-agent: cancel after archive on agent "${agent.id}" failed: ${error instanceof Error ? error.message : String(error)}`);
          }
          logger?.info?.(`dsh-loop-agent: agent "${agent.id}" archived; endless run stopped`);
        }
      }
      /* Sweep stale armedAgentIds entries. The /forever handler deletes the
       * agent from `states` BEFORE setting `armedAgentIds`, so if that agent
       * leaves the registry (conversation deleted / torn down) before the
       * supervisor consumes the pending arm, the cleanup loop above never
       * sees it in `states` and its entry would linger — and a later
       * `resumeSessionId` of the same id would then be wrongly re-armed
       * without a fresh /forever. Drop any armed id that is no longer live
       * (or is now archived) so a pending arm only survives while its agent
       * actually exists and is unarchived. */
      for (const id of [...armedAgentIds.keys()]) {
        if (!live.some((a) => a.id === id) || archived?.has(id)) {
          armedAgentIds.delete(id);
        }
      }
    }, 1000);
    return () => {
      tornDown = true;
      clearInterval(timer);
      for (const state of states.values()) state.disarm();
      states.clear();
      armedAgentIds.clear(); // Clean up pending arming requests to prevent memory leak
    };
  }, "dsh-loop-agent: registry supervisor");

}
//#endregion
export { Config, apply, inject, name };
