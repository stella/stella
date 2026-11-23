import { panic, Result } from "better-result";
import { realpathSync } from "node:fs";
import path from "node:path";
import { Temporal } from "temporal-polyfill/full";
import * as v from "valibot";

import { chatLocalRunToolResultContent } from "@stll/api-contract/chat-local-run-tool";
import type { DESKTOP_RUNNER_APPROVAL_DECISIONS } from "@stll/api-contract/desktop-runner";
import { isPathInside } from "@stll/portable-path";

import type {
  HarnessInteractionResponse,
  HarnessRespondError,
  HarnessRunPolicy,
  HarnessSteerInput,
  HarnessTurn,
} from "../adapter";
import {
  type HarnessApprovalOption,
  type HarnessApprovalRequest,
  harnessContextUsage,
  type HarnessContinuation,
  type HarnessEvent,
  type HarnessFailure,
  harnessSessionId,
  type HarnessToolCall,
  type HarnessUsage,
} from "../events";
import { HARNESS_TOOL_NAMES, nativeToolCall } from "../tool-parts";
import {
  type Detached,
  type HarnessExit,
  HarnessTurnLifecycle,
  respondError,
  settlesWithin,
} from "../turn-lifecycle";
import type { AcpAnswer, AcpClient, AcpHandlers } from "./client";
import type { AcpAgentDefinition } from "./definition";
import {
  ACP_AGENT_NOTIFICATIONS,
  ACP_AGENT_REQUESTS,
  ACP_ERROR,
  acpBlockText,
  type AcpPermissionOutcome,
  AcpPromptResponseSchema,
  type AcpRequestId,
  AcpRequestPermissionSchema,
  AcpSessionNotificationSchema,
  type AcpSessionUpdate,
  AcpSessionUpdateSchema,
} from "./protocol";
import {
  type AcpMcpNames,
  type AcpToolCallState,
  harnessToolCall,
  harnessToolResult,
  isFinished,
  mcpToolOfTitle,
  mergeToolCall,
  toolCallChanged,
  toolCallPaths,
} from "./tool-calls";

/** The name a plan step is shown under; ACP gives plans no tool of their own. */
const PLAN_TOOL = "plan";

type ApprovalDecision = (typeof DESKTOP_RUNNER_APPROVAL_DECISIONS)[number];

/** Each ACP permission option kind as the decision chat offers for it. */
const DECISION_OF_OPTION: Readonly<Record<string, ApprovalDecision>> = {
  allow_once: "approve",
  allow_always: "approve_for_session",
  reject_once: "deny",
};

/**
 * `file` with every link resolved: the real path of its nearest existing
 * ancestor, then the rest as written, so a file not made yet resolves too.
 */
const existingRealPath = (file: string): string | null => {
  const real = Result.try(() => realpathSync.native(file));
  return Result.isOk(real) ? real.value : null;
};

const realPathOf = (file: string): string | null => {
  if (!path.isAbsolute(file)) {
    return null;
  }
  // Each part is taken in the order the file system walks it: a link is
  // followed before a `..` after it climbs out of where the link leads.
  const parts = file.split(/[\\/]+/u).filter((part) => part !== "");
  let current =
    existingRealPath(path.parse(file).root) ?? path.parse(file).root;
  let missing = false;
  for (const part of parts) {
    if (part === ".") {
      continue;
    }
    if (part === "..") {
      // Past a part that does not exist, where `..` leads is unknown.
      if (missing) {
        return null;
      }
      current = path.dirname(current);
      continue;
    }
    const next = path.join(current, part);
    const real: string | null = missing ? null : existingRealPath(next);
    missing = real === null;
    current = real ?? next;
  }
  return current;
};

/** What stella does with a permission request before the member sees it. */
export type PermissionDisposition = "allow" | "deny" | "ask";

const READ_KINDS: ReadonlySet<string> = new Set(["read", "search", "think"]);
const WRITE_KINDS: ReadonlySet<string> = new Set(["edit", "delete", "move"]);

/**
 * stella's answer to a permission request at the turn's approval mode. A
 * step that touches a path the turn may not read is refused in every mode;
 * reading inside the run's folder never asks; writing inside it and fetching
 * from the web do not ask in auto; anything else (a command, a step outside
 * the folder, an MCP tool the agent asks about) goes to the member.
 */
export const permissionDisposition = ({
  call,
  policy,
  workspaceDir,
  unreadablePaths,
  mcpNames,
}: {
  call: AcpToolCallState;
  policy: HarnessRunPolicy;
  workspaceDir: string;
  unreadablePaths: readonly string[];
  mcpNames: AcpMcpNames;
}): PermissionDisposition => {
  // Where each path really is, through any link on the way, so a link in
  // the folder to somewhere else is judged by where it leads.
  const workspace = realPathOf(workspaceDir) ?? workspaceDir;
  const unreadable = unreadablePaths.map((root) => realPathOf(root) ?? root);
  const resolved = toolCallPaths(call).map((file) =>
    // Joined as written: resolving `..` by name first could skip a link.
    realPathOf(
      path.isAbsolute(file) ? file : `${workspaceDir}${path.sep}${file}`,
    ),
  );
  // A path stella cannot follow is never allowed without asking.
  if (resolved.includes(null)) {
    return "ask";
  }
  const files = resolved.filter((file) => file !== null);
  if (
    files.some((file) =>
      unreadable.some(
        (root) => isPathInside(root, file) && !isPathInside(workspace, file),
      ),
    )
  ) {
    return "deny";
  }
  // An MCP tool's own kind is the agent's guess; the member decides. A
  // title that names a registered server at all is taken as one.
  if (
    mcpToolOfTitle(call.title, mcpNames) !== null ||
    [mcpNames.stella, ...mcpNames.others].some((server) =>
      call.title.includes(server),
    )
  ) {
    return "ask";
  }
  const inside =
    files.length > 0 && files.every((file) => isPathInside(workspace, file));
  const kind = call.kind ?? "other";
  if (READ_KINDS.has(kind) && inside) {
    return "allow";
  }
  if (WRITE_KINDS.has(kind) && inside) {
    return policy.approvals === "auto" ? "allow" : "ask";
  }
  if (kind === "fetch" && files.length === 0) {
    return policy.approvals === "auto" ? "allow" : "ask";
  }
  return "ask";
};

const approvalKindOf = (
  call: AcpToolCallState,
  shown: HarnessToolCall,
): HarnessApprovalRequest["kind"] => {
  if (shown.name === HARNESS_TOOL_NAMES.commandExecution) {
    return "command";
  }
  if (shown.name === HARNESS_TOOL_NAMES.fileChange) {
    return "file_change";
  }
  return call.kind === null ||
    Object.values(HARNESS_TOOL_NAMES).some((name) => name === shown.name)
    ? "tool"
    : "mcp_tool";
};

type PendingPermission = {
  jsonRpcId: AcpRequestId;
  toolCallId: string;
  options: readonly HarnessApprovalOption[];
};

type TrackedCall = {
  state: AcpToolCallState;
  /** The call as chat shows it, fixed once it was opened. */
  shown: HarnessToolCall | null;
  done: boolean;
};

const ACP_FAILURE_OF_STOP: Readonly<
  Record<string, { code: string; message: string }>
> = {
  max_tokens: {
    code: "max_tokens",
    message: "The agent stopped: the model reached its output limit.",
  },
  max_turn_requests: {
    code: "max_turn_requests",
    message: "The agent stopped: the turn reached its limit of model requests.",
  },
  refusal: {
    code: "refusal",
    message: "The agent refused to continue this request.",
  },
};

/** Milliseconds as `performance.now()` counts them, and a wait. */
export type AcpStderrClock = {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
};

const SYSTEM_STDERR_CLOCK: AcpStderrClock = {
  now: () => performance.now(),
  sleep: async (ms) => {
    await Bun.sleep(ms);
  },
};

/** Quiet that counts as drained, the most a turn start waits, and the step. */
const STDERR_QUIET_MS = 100;
const STDERR_QUIET_CAP_MS = 250;
const STDERR_QUIET_POLL_MS = 20;

/**
 * Settles once stderr has read nothing new for `STDERR_QUIET_MS`, or after
 * `STDERR_QUIET_CAP_MS` however busy it stays.
 */
const awaitStderrQuiet = async (
  client: AcpClient,
  clock: AcpStderrClock,
): Promise<void> => {
  const started = clock.now();
  const step = async (seen: number, quietSince: number): Promise<void> => {
    const now = clock.now();
    if (
      now - quietSince >= STDERR_QUIET_MS ||
      now - started >= STDERR_QUIET_CAP_MS
    ) {
      return;
    }
    await clock.sleep(
      Math.min(STDERR_QUIET_POLL_MS, STDERR_QUIET_CAP_MS - (now - started)),
    );
    const latest = client.stderrBytesSeen();
    await (latest === seen
      ? step(seen, quietSince)
      : step(latest, clock.now()));
  };
  await step(client.stderrBytesSeen(), started);
};

export type AcpTurnOptions = {
  gracePeriodMs: number;
  detached: Detached;
  /** The agent's name in failures stella reports. */
  displayName: string;
  mcpNames: AcpMcpNames;
  policy: HarnessRunPolicy;
  workspaceDir: string;
  unreadablePaths: readonly string[];
  /** Called with a failed prompt's error text, for the adapter to read. */
  onPromptError: (message: string) => void;
  /** Called when a classified failure marks the agent's saved session broken. */
  onBrokenSession?: () => void;
  /** Whether a running tool outlives `session/prompt` and keeps the turn open. */
  toolOutlivesPrompt?: AcpAgentDefinition["toolOutlivesPrompt"];
  /** Classifies failures from captured stderr or error output. */
  classifyErrorOutput?: AcpAgentDefinition["classifyErrorOutput"];
  /** Debounce before settling a turn held for background work once tools finish. */
  backgroundSettleMs?: number;
  /** Time for the wait before the turn's stderr mark; the system clock by default. */
  stderrClock?: AcpStderrClock;
};

type PromptUsage = NonNullable<
  v.InferOutput<typeof AcpPromptResponseSchema>["usage"]
>;

/**
 * One ACP turn: a `session/prompt` and the `session/update` notifications
 * of its session, as harness events. The prompt's answer ends the turn; the
 * shared lifecycle stops and ends the process.
 */
export class AcpTurnSession {
  private readonly lifecycle: HarnessTurnLifecycle<AcpClient>;
  private readonly options: AcpTurnOptions;
  private sessionId: string | null = null;
  /** Updates for a session being loaded replay its history: not this turn's. */
  private replaying: string | null = null;
  private readonly calls = new Map<string, TrackedCall>();
  private readonly permissions = new Map<string, PendingPermission>();
  private nextPermission = 1;
  private message: { id: string; text: string } | null = null;
  private messageCount = 0;
  private thought = "";
  private planCount = 0;
  private context: { used: number; size: number } | null = null;
  /** True once the model has emitted any message, thought, or tool call. */
  private reachedModel = false;
  /** True while the turn stays open waiting for outliving background tools. */
  private heldForBackground = false;
  private backgroundSettleTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * The agent takes a prompt sent while one runs into the running turn: the
   * earlier prompt then ends and the turn goes on under the new one. Known
   * once the agent said its version.
   */
  private steering = false;
  /** The answer of the last prompt sent; settled before any was sent. */
  private promptAnswer: Promise<unknown> = Promise.resolve();
  /** Steering messages not settled yet, by the prompt that carries them. */
  private readonly steeringInputs = new Map<
    number,
    { inputId: string; during: number; heldBefore: boolean }
  >();
  /** The prompt whose answer ends the turn: the last one sent. */
  private latestPrompt = 0;
  /** The highest prompt index whose answer has arrived. */
  private answeredPrompt = 0;
  /** Length of client stderr when this turn attached, for turn-scoped classification. */
  private stderrStartByte = 0;
  /** What every answered prompt of the turn used, steered ones included. */
  private readonly promptUsage: PromptUsage[] = [];

  constructor(options: AcpTurnOptions) {
    this.options = options;
    this.lifecycle = new HarnessTurnLifecycle<AcpClient>({
      gracePeriodMs: options.gracePeriodMs,
      detached: options.detached,
      name: "acp-turn",
    });
  }

  readonly handlers: AcpHandlers = {
    notification: (method, params) => {
      this.notification(method, params);
    },
    request: (id, method, params) => {
      this.request(id, method, params);
    },
    violation: (message) => {
      this.closeCalls("interrupted");
      this.lifecycle.violation(message);
    },
    exit: (exit: HarnessExit) => {
      this.clearBackgroundSettle();
      const wasHeld = this.heldForBackground;
      this.heldForBackground = false;
      const classified = this.classifyStderr(null, null);
      if (
        classified !== null &&
        !this.lifecycle.ended &&
        !this.lifecycle.interrupting
      ) {
        if (classified.brokenSession) {
          this.options.onBrokenSession?.();
        }
        this.fail(classified.failure);
        this.lifecycle.exited(exit);
        return;
      }
      this.closeCalls(wasHeld ? "failed" : "interrupted");
      this.lifecycle.exited(exit);
    },
  };

  attach(client: AcpClient) {
    this.stderrStartByte = client.stderrBytesSeen();
    this.lifecycle.attach(client);
  }

  /**
   * The turn's stderr mark, taken once stderr is quiet: the mark counts bytes
   * read, so output an earlier turn wrote but not yet read is credited to
   * that turn rather than classified as this one's.
   */
  async settleStderrMark() {
    const client = this.lifecycle.client;
    if (client === null) {
      return;
    }
    await awaitStderrQuiet(
      client,
      this.options.stderrClock ?? SYSTEM_STDERR_CLOCK,
    );
    this.stderrStartByte = client.stderrBytesSeen();
  }

  abandon() {
    this.clearBackgroundSettle();
    this.heldForBackground = false;
    this.lifecycle.abandon();
  }

  /** Updates for `sessionId` are replayed history until `loaded`. */
  loading(sessionId: string) {
    this.replaying = sessionId;
  }

  loaded() {
    this.replaying = null;
  }

  steers(steering: boolean) {
    this.steering = steering;
  }

  /** The session the prompt runs in; announced before any of its output. */
  begin(sessionId: string, continuation: HarnessContinuation) {
    this.sessionId = sessionId;
    this.emit({
      type: "session.started",
      sessionId: harnessSessionId(sessionId),
      continuation,
    });
  }

  /** A prompt was sent; the last one's answer ends the turn. */
  prompted(answer: Promise<AcpAnswer>) {
    this.clearBackgroundSettle();
    this.heldForBackground = false;
    this.promptAnswer = answer;
    this.latestPrompt += 1;
    const prompt = this.latestPrompt;
    this.options.detached(
      (async () => {
        this.answered(prompt, await answer);
      })(),
      "acp-turn.prompt",
    );
  }

  /**
   * A steered prompt's predecessor ends as the agent hands the turn over;
   * only its usage counts.
   */
  private answered(prompt: number, answer: AcpAnswer) {
    if (Result.isOk(answer)) {
      const parsed = v.safeParse(AcpPromptResponseSchema, answer.value);
      if (
        parsed.success &&
        parsed.output.usage !== null &&
        parsed.output.usage !== undefined
      ) {
        this.promptUsage.push(parsed.output.usage);
      }
    }
    // The prompt a steering message was sent during has ended: the agent
    // took the message into the turn.
    for (const [steered, steer] of this.steeringInputs) {
      if (steer.during === prompt) {
        this.steeringInputs.delete(steered);
        this.lifecycle.settleInput(steer.inputId, "accepted");
      }
    }
    const steer = this.steeringInputs.get(prompt);
    if (steer !== undefined && Result.isError(answer)) {
      // Refused while the earlier prompt runs on: the message is not this
      // turn's, and the earlier prompt still ends the turn.
      this.steeringInputs.delete(prompt);
      this.lifecycle.settleInput(steer.inputId, "rejected");
      if (this.latestPrompt === prompt) {
        this.latestPrompt = steer.during;
        // The earlier prompt had already ended into background work: the
        // turn waits on that work again, as it did before the steer.
        if (steer.heldBefore && !this.lifecycle.ended) {
          this.heldForBackground = true;
          this.maybeSettleBackground(false);
        }
      }
      return;
    }
    if (prompt > this.answeredPrompt) {
      this.answeredPrompt = prompt;
    }
    if (prompt === this.latestPrompt) {
      this.finish(answer);
    }
  }

  private steerWith(input: HarnessSteerInput) {
    const client = this.lifecycle.client;
    if (
      !this.steering ||
      // One handover at a time: a message sent while another is still being
      // handed over waits for the next turn.
      this.steeringInputs.size > 0 ||
      client === null ||
      this.sessionId === null ||
      this.lifecycle.interrupting
    ) {
      this.lifecycle.settleInput(input.inputId, "rejected");
      return;
    }
    this.flushText();
    const during = this.latestPrompt;
    const heldBefore = this.heldForBackground;
    this.prompted(
      client.request("session/prompt", {
        sessionId: this.sessionId,
        prompt: [{ type: "text", text: input.text }],
      }),
    );
    // Settled once the agent hands the turn over (the earlier prompt ends)
    // or refuses the message.
    this.steeringInputs.set(this.latestPrompt, {
      inputId: input.inputId,
      during,
      heldBefore,
    });
  }

  turn(): HarnessTurn {
    return this.lifecycle.turn({
      respond: (response) => this.respond(response),
      steer: (input: HarnessSteerInput) => {
        this.steerWith(input);
      },
      interrupt: async () => {
        await this.lifecycle.interrupt(async (client) => {
          this.clearBackgroundSettle();
          this.cancelPermissions();
          if (this.sessionId !== null) {
            client.notify("session/cancel", { sessionId: this.sessionId });
          }
          if (this.heldForBackground) {
            this.heldForBackground = false;
            this.flushText();
            this.closeCalls("interrupted");
            this.emit({ type: "turn.interrupted" });
            return true;
          }
          // ACP's cancel is a notification: the prompt's answer confirms it.
          await settlesWithin(this.promptAnswer, this.lifecycle.gracePeriodMs);
          return true;
        });
      },
    });
  }

  private emit(event: HarnessEvent) {
    this.lifecycle.emit(event);
  }

  private notification(method: string, params: unknown) {
    if (method !== ACP_AGENT_NOTIFICATIONS.update || this.lifecycle.ended) {
      return;
    }
    const parsed = v.safeParse(AcpSessionNotificationSchema, params);
    if (!parsed.success) {
      this.handlers.violation(
        "The agent sent a session update without a session.",
      );
      return;
    }
    const { sessionId, update } = parsed.output;
    if (sessionId === this.replaying || sessionId !== this.sessionId) {
      return;
    }
    // A kind stella does not read, or one a newer protocol shaped
    // differently, is dropped: it never ends the turn.
    const known = v.safeParse(AcpSessionUpdateSchema, update);
    if (known.success) {
      this.update(known.output);
    }
  }

  private update(update: AcpSessionUpdate) {
    switch (update.sessionUpdate) {
      case "agent_message_chunk": {
        const text = acpBlockText(update.content);
        if (text === null || text === "") {
          return;
        }
        this.reachedModel = true;
        this.flushThought();
        if (this.message === null) {
          this.messageCount += 1;
          this.message = {
            id: `${this.sessionId ?? "acp"}:message:${String(this.messageCount)}`,
            text: "",
          };
        }
        this.message.text += text;
        this.emit({
          type: "text.delta",
          messageId: this.message.id,
          delta: text,
        });
        this.maybeSettleBackground(false);
        return;
      }
      case "agent_thought_chunk": {
        const text = acpBlockText(update.content);
        if (text !== null) {
          this.reachedModel = true;
          this.flushMessage();
          this.thought += text;
        }
        return;
      }
      case "tool_call":
      case "tool_call_update": {
        this.reachedModel = true;
        const { sessionUpdate: _kind, ...fields } = update;
        this.toolCall(fields);
        this.maybeSettleBackground(false);
        return;
      }
      case "plan":
        this.plan(update.entries.map((entry) => entry.content));
        return;
      case "usage_update":
        this.context = { used: update.used, size: update.size };
        this.maybeSettleBackground(true);
        return;
      case "user_message_chunk":
      case "current_mode_update":
        return;
      default:
        update satisfies never;
        panic("Unhandled ACP session update");
    }
  }

  private flushMessage() {
    if (this.message !== null) {
      this.emit({
        type: "text.completed",
        messageId: this.message.id,
        text: this.message.text,
      });
      this.message = null;
    }
  }

  private flushThought() {
    const text = this.thought.trim();
    this.thought = "";
    if (text !== "") {
      this.messageCount += 1;
      this.emit({
        type: "reasoning.completed",
        messageId: `${this.sessionId ?? "acp"}:thought:${String(this.messageCount)}`,
        text,
      });
    }
  }

  private flushText() {
    this.flushMessage();
    this.flushThought();
  }

  private toolCall(fields: Parameters<typeof mergeToolCall>[1]) {
    const tracked = this.calls.get(fields.toolCallId);
    if (tracked?.done === true) {
      // Output arriving after the call ended does not reopen it.
      return;
    }
    const state = mergeToolCall(tracked?.state ?? null, fields);
    if (tracked !== undefined && !toolCallChanged(tracked.state, state)) {
      return;
    }
    const call: TrackedCall = tracked ?? { state, shown: null, done: false };
    call.state = state;
    this.calls.set(state.id, call);
    // A call opens once it runs: the input an agent streams in while the
    // call is pending is then complete.
    if (state.status !== "pending") {
      this.open(call);
    }
    if (isFinished(state)) {
      this.complete(call, state.status === "failed" ? "failed" : "completed");
    }
  }

  private open(call: TrackedCall): HarnessToolCall {
    if (call.shown !== null) {
      return call.shown;
    }
    this.flushText();
    const shown = harnessToolCall(call.state, this.options.mcpNames);
    call.shown = shown;
    this.emit({ type: "tool.started", toolCall: shown });
    return shown;
  }

  private complete(
    call: TrackedCall,
    ending: Parameters<typeof harnessToolResult>[2],
  ) {
    if (call.done) {
      return;
    }
    const shown = this.open(call);
    call.done = true;
    this.emit({
      type: "tool.completed",
      toolCall: shown,
      result: harnessToolResult(call.state, shown, ending),
    });
  }

  /** Every call the turn left open ends with it. */
  private closeCalls(ending: "interrupted" | "failed") {
    for (const call of this.calls.values()) {
      if (!call.done && (call.shown !== null || call.state.title !== "")) {
        this.complete(call, ending);
      }
    }
  }

  /** Each plan the agent reports is its own completed step. */
  private plan(items: readonly string[]) {
    this.flushText();
    this.planCount += 1;
    const toolCall = nativeToolCall(
      `${this.sessionId ?? "acp"}:plan:${String(this.planCount)}`,
      {
        name: HARNESS_TOOL_NAMES.nativeTool,
        input: { tool: PLAN_TOOL, detail: { kind: "plan", items: [...items] } },
      },
    );
    this.emit({ type: "tool.started", toolCall });
    this.emit({
      type: "tool.completed",
      toolCall,
      result: {
        content: chatLocalRunToolResultContent({
          name: HARNESS_TOOL_NAMES.nativeTool,
          result: { status: "completed" },
        }),
        status: "succeeded",
      },
    });
  }

  private request(id: AcpRequestId, method: string, params: unknown) {
    const client = this.lifecycle.client;
    if (client === null) {
      return;
    }
    if (method !== ACP_AGENT_REQUESTS.requestPermission) {
      client.respondError(
        id,
        ACP_ERROR.methodNotFound,
        `stella does not answer ${method}.`,
      );
      return;
    }
    const parsed = v.safeParse(AcpRequestPermissionSchema, params);
    if (!parsed.success || parsed.output.sessionId !== this.sessionId) {
      client.respondError(
        id,
        ACP_ERROR.invalidParams,
        "stella cannot read this permission request.",
      );
      return;
    }
    const request = parsed.output;
    const tracked = this.calls.get(request.toolCall.toolCallId);
    const state = mergeToolCall(tracked?.state ?? null, request.toolCall);
    const call: TrackedCall = tracked ?? { state, shown: null, done: false };
    call.state = state;
    this.calls.set(state.id, call);
    const optionOf = (kind: string) =>
      request.options.find((option) => option.kind === kind)?.optionId ?? null;
    const answer = (outcome: AcpPermissionOutcome) => {
      client.respond(id, { outcome });
    };
    if (this.lifecycle.ended || this.lifecycle.interrupting) {
      answer({ outcome: "cancelled" });
      return;
    }
    const disposition = permissionDisposition({
      call: state,
      policy: this.options.policy,
      workspaceDir: this.options.workspaceDir,
      unreadablePaths: this.options.unreadablePaths,
      mcpNames: this.options.mcpNames,
    });
    if (disposition !== "ask") {
      const optionId =
        disposition === "allow"
          ? (optionOf("allow_once") ?? optionOf("allow_always"))
          : optionOf("reject_once");
      answer(
        optionId === null
          ? { outcome: "cancelled" }
          : { outcome: "selected", optionId },
      );
      return;
    }
    const options: HarnessApprovalOption[] = [];
    for (const option of request.options) {
      const decision = DECISION_OF_OPTION[option.kind];
      if (
        decision !== undefined &&
        !options.some((offered) => offered.decision === decision)
      ) {
        options.push({ id: option.optionId, decision });
      }
    }
    if (options.length === 0) {
      answer({ outcome: "cancelled" });
      return;
    }
    const shown = this.open(call);
    const requestId = `acp-permission-${String(this.nextPermission)}`;
    this.nextPermission += 1;
    this.clearBackgroundSettle();
    this.permissions.set(requestId, {
      jsonRpcId: id,
      toolCallId: state.id,
      options,
    });
    this.emit({
      type: "approval.requested",
      request: {
        requestId,
        kind: approvalKindOf(state, shown),
        toolCall: shown,
        reason: null,
        options,
      },
    });
  }

  private respond(
    response: HarnessInteractionResponse,
  ): Result<void, HarnessRespondError> {
    if (this.lifecycle.ended) {
      return respondError("turn_ended", "The turn has already ended.");
    }
    const pending = this.permissions.get(response.requestId);
    if (pending === undefined) {
      return respondError("unknown_request", "No such request is pending.");
    }
    if (response.type !== "approval") {
      return respondError(
        "invalid_response",
        "A permission request takes an approval.",
      );
    }
    const option = pending.options.find(
      (offered) => offered.decision === response.decision,
    );
    if (option === undefined) {
      return respondError(
        "invalid_response",
        "The request did not offer this decision.",
      );
    }
    this.permissions.delete(response.requestId);
    this.lifecycle.client?.respond(pending.jsonRpcId, {
      outcome: { outcome: "selected", optionId: option.id },
    });
    this.emit({ type: "interaction.resolved", requestId: response.requestId });
    if (response.decision === "deny") {
      const call = this.calls.get(pending.toolCallId);
      if (call !== undefined) {
        this.complete(call, "declined");
      }
    }
    return Result.ok();
  }

  /** Every pending permission request is withdrawn, as ACP asks on cancel. */
  private cancelPermissions() {
    for (const [requestId, pending] of this.permissions) {
      this.lifecycle.client?.respond(pending.jsonRpcId, {
        outcome: { outcome: "cancelled" },
      });
      this.emit({ type: "interaction.resolved", requestId });
    }
    this.permissions.clear();
  }

  /** The turn's usage: every prompt's tokens, the last context reported. */
  private usage(): HarnessUsage | null {
    const context =
      this.context === null
        ? null
        : harnessContextUsage(this.context.used, this.context.size);
    if (this.promptUsage.length === 0 && context === null) {
      return null;
    }
    const sum = (field: keyof PromptUsage) =>
      this.promptUsage.reduce((total, usage) => total + (usage[field] ?? 0), 0);
    return {
      inputTokens: sum("inputTokens"),
      cachedInputTokens: sum("cachedReadTokens"),
      outputTokens: sum("outputTokens"),
      reasoningOutputTokens: sum("thoughtTokens"),
      context,
    };
  }

  private clearBackgroundSettle() {
    if (this.backgroundSettleTimer !== null) {
      clearTimeout(this.backgroundSettleTimer);
      this.backgroundSettleTimer = null;
    }
  }

  private hasOutlivingTools(): boolean {
    const check = this.options.toolOutlivesPrompt;
    if (check === undefined) {
      return false;
    }
    for (const call of this.calls.values()) {
      if (
        !call.done &&
        call.state.status === "in_progress" &&
        check(call.state)
      ) {
        return true;
      }
    }
    return false;
  }

  private hasHeldCompletionBlocker() {
    return (
      this.hasOutlivingTools() ||
      this.permissions.size > 0 ||
      this.answeredPrompt < this.latestPrompt
    );
  }

  private maybeSettleBackground(usageUpdated: boolean) {
    if (!this.heldForBackground || this.lifecycle.ended) {
      return;
    }
    if (this.hasHeldCompletionBlocker()) {
      this.clearBackgroundSettle();
      return;
    }
    if (usageUpdated) {
      this.completeHeldTurn();
      return;
    }
    this.clearBackgroundSettle();
    const settleMs = this.options.backgroundSettleMs ?? 1500;
    this.backgroundSettleTimer = setTimeout(() => {
      this.backgroundSettleTimer = null;
      this.completeHeldTurn();
    }, settleMs);
  }

  private completeHeldTurn() {
    if (
      !this.heldForBackground ||
      this.lifecycle.ended ||
      this.hasHeldCompletionBlocker()
    ) {
      return;
    }
    // The agent can report a quota or a broken session on stderr while the
    // background work runs, after the prompt's answer was already clean.
    const classified = this.classifyStderr(null, null);
    if (classified !== null) {
      if (classified.brokenSession) {
        this.options.onBrokenSession?.();
      }
      this.fail(classified.failure);
      return;
    }
    this.clearBackgroundSettle();
    this.heldForBackground = false;
    this.flushText();
    this.closeCalls("interrupted");
    this.emit({
      type: "turn.completed",
      usage: this.usage(),
      boundary: null,
    });
  }

  private classifyStderr(
    errorMessage: string | null,
    stopReason: string | null,
  ) {
    const classify = this.options.classifyErrorOutput;
    if (classify === undefined) {
      return null;
    }
    // Only what the agent wrote during this turn. A length taken from the
    // bounded tail stops growing once it is full, so the mark counts bytes.
    const stderr =
      this.lifecycle.client?.stderrSince(this.stderrStartByte) ?? "";
    return classify({
      stderr,
      errorMessage,
      stopReason,
      reachedModel: this.reachedModel,
      now: Temporal.Now.instant(),
    });
  }

  private fail(failure: HarnessFailure) {
    this.clearBackgroundSettle();
    this.heldForBackground = false;
    this.flushText();
    this.closeCalls("failed");
    this.emit({ type: "turn.failed", failure });
  }

  private finish(answer: AcpAnswer) {
    if (this.lifecycle.ended) {
      return;
    }
    this.cancelPermissions();
    if (Result.isError(answer)) {
      const { error } = answer;
      if (error.reason !== "rejected") {
        // The process ended or stopped answering: its exit ends the turn.
        return;
      }
      if (this.lifecycle.interrupting) {
        this.flushText();
        this.closeCalls("interrupted");
        this.emit({ type: "turn.interrupted" });
        return;
      }
      this.options.onPromptError(error.message);
      const classified = this.classifyStderr(error.message, null);
      if (classified !== null) {
        if (classified.brokenSession) {
          this.options.onBrokenSession?.();
        }
        this.fail(classified.failure);
        return;
      }
      this.fail(
        error.code === ACP_ERROR.authRequired
          ? {
              type: "auth_required",
              message: `${this.options.displayName} is not signed in.`,
            }
          : {
              type: "provider_error",
              message: error.message,
              code: String(error.code ?? "error"),
            },
      );
      return;
    }
    const parsed = v.safeParse(AcpPromptResponseSchema, answer.value);
    if (!parsed.success) {
      this.fail({
        type: "protocol_violation",
        message: "The agent answered the prompt with an unexpected shape.",
      });
      return;
    }
    const { stopReason } = parsed.output;
    if (stopReason === "cancelled" || this.lifecycle.interrupting) {
      this.flushText();
      this.closeCalls("interrupted");
      this.emit({ type: "turn.interrupted" });
      return;
    }
    const classifiedStop = this.classifyStderr(null, stopReason);
    if (classifiedStop !== null) {
      if (classifiedStop.brokenSession) {
        this.options.onBrokenSession?.();
      }
      this.fail(classifiedStop.failure);
      return;
    }
    const stopped = ACP_FAILURE_OF_STOP[stopReason];
    if (stopped !== undefined) {
      this.fail({ type: "provider_error", ...stopped });
      return;
    }
    if (this.hasOutlivingTools()) {
      this.heldForBackground = true;
      return;
    }
    this.flushText();
    this.closeCalls("interrupted");
    this.emit({
      type: "turn.completed",
      usage: this.usage(),
      boundary: null,
    });
  }
}
