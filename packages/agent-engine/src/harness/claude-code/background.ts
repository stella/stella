import { panic } from "better-result";
import * as v from "valibot";

import type { HarnessLiveSession } from "../adapter";
import type { HarnessSessionId } from "../events";
import {
  BackgroundTasks,
  keepLiveSession,
  type KeptSession,
} from "../live-session";
import {
  type Detached,
  type HarnessTurnBackground,
  settlesWithin,
} from "../turn-lifecycle";
import type { ClaudeCliClient, ClaudeCliHandlers } from "./cli-client";
import {
  BackgroundTasksChangedSchema,
  CLAUDE_BACKGROUND_COMMAND_TASK,
} from "./protocol";

/**
 * Claude Code's background work, across the turns one CLI process hosts.
 *
 * A Bash command the agent runs in the background is a task of the CLI
 * process: the next turn reads its output or stops it by its task id, and the
 * CLI reports the whole set of live tasks (`background_tasks_changed`) each
 * time it changes. Tasks live in the process and end with it, so a turn that
 * completes with a command running keeps the process (`keepLiveSession`) and
 * the chat's next turn is the next user message on its stdin. Background
 * sub-agents are not kept: they would go on working with nobody to see it,
 * so they are stopped when the turn ends. `stop_task` ends each task before
 * the process closes.
 *
 * When a background task ends the CLI may open a turn of its own to report
 * it. Between stella's turns nobody reads that turn, so it is interrupted;
 * the report stays in the session for the next turn.
 */

/** The live sessions this adapter made, to continue a turn in. */
const KEPT = new WeakMap<HarnessLiveSession, ClaudeProcess>();

/** What the CLI writes when it opens a turn of its own between turns. */
const OWN_TURN_OUTPUT: ReadonlySet<string> = new Set([
  "assistant",
  "stream_event",
]);

const IGNORED: ClaudeCliHandlers = {
  message: () => undefined,
  controlRequest: () => undefined,
  controlCancel: () => undefined,
  violation: () => undefined,
  exit: () => undefined,
};

/**
 * One CLI process across the turns it hosts. Its messages go to the turn
 * that holds it. Between turns, while it is kept for work a turn left in the
 * background, a turn the CLI opens itself is interrupted and its requests
 * are refused.
 */
export class ClaudeProcess {
  readonly background = new BackgroundTasks();
  private target: ClaudeCliHandlers = IGNORED;
  private attached: ClaudeCliClient | null = null;
  /** Live background task ids to their kind, as the CLI last listed them. */
  private tasks: ReadonlyMap<string, string> = new Map();
  private kept: KeptSession | null = null;
  /** An own turn of the CLI is being interrupted until its result. */
  private interruptingOwnTurn = false;
  private readonly gracePeriodMs: number;
  private readonly detached: Detached;

  constructor(options: { gracePeriodMs: number; detached: Detached }) {
    this.gracePeriodMs = options.gracePeriodMs;
    this.detached = options.detached;
  }

  /** The process that keeps `session`, if this adapter made it. */
  static of(session: HarnessLiveSession): ClaudeProcess | undefined {
    return KEPT.get(session);
  }

  /** The handlers the process is started with. */
  readonly handlers: ClaudeCliHandlers = {
    message: (type, raw) => {
      this.observe(type, raw);
      this.target.message(type, raw);
    },
    controlRequest: (requestId, subtype, request) => {
      this.target.controlRequest(requestId, subtype, request);
    },
    controlCancel: (requestId) => {
      this.target.controlCancel(requestId);
    },
    violation: (message) => {
      this.target.violation(message);
    },
    exit: (exit) => {
      this.target.exit(exit);
    },
  };

  /** The started process; set once, right after it started. */
  attach(client: ClaudeCliClient) {
    this.attached = client;
  }

  get client(): ClaudeCliClient {
    return (
      this.attached ?? panic("Claude Code process: used before it was attached")
    );
  }

  /** Hand the process's messages to the turn that holds it now. */
  route(handlers: ClaudeCliHandlers) {
    this.target = handlers;
  }

  /** The turn's end: keep the process for its background work, or end it. */
  turnBackground(
    sessionId: HarnessSessionId,
  ): HarnessTurnBackground<ClaudeCliClient> {
    return {
      keep: async (client) => this.keep(client, sessionId),
      stopBackground: async (client) => this.stopAll(client),
    };
  }

  /** Ends every background task the CLI lists. */
  async stopAll(client: ClaudeCliClient) {
    await this.stop(client, this.tasks.keys());
  }

  /**
   * The next turn takes the process `session` keeps; `false` once that
   * session is ending or ended.
   */
  take(session: HarnessLiveSession): boolean {
    const kept = this.kept;
    if (kept?.session !== session || !kept.take()) {
      return false;
    }
    this.kept = null;
    return true;
  }

  /** Ends each of `taskIds`; a task that ended meanwhile is refused. */
  async stop(client: ClaudeCliClient, taskIds: Iterable<string>) {
    await Promise.allSettled(
      [...taskIds].map(async (taskId) =>
        client.request("stop_task", { task_id: taskId }),
      ),
    );
  }

  private commands() {
    return [...this.tasks.values()].filter(
      (kind) => kind === CLAUDE_BACKGROUND_COMMAND_TASK,
    ).length;
  }

  private async keep(
    client: ClaudeCliClient,
    sessionId: HarnessSessionId,
  ): Promise<HarnessLiveSession | null> {
    if (this.commands() === 0) {
      return null;
    }
    await settlesWithin(
      this.stop(
        client,
        [...this.tasks].flatMap(([taskId, kind]) =>
          kind === CLAUDE_BACKGROUND_COMMAND_TASK ? [] : [taskId],
        ),
      ),
      this.gracePeriodMs,
    );
    const kept = keepLiveSession({
      harness: "claude-code",
      sessionId,
      process: client,
      background: this.background,
      gracePeriodMs: this.gracePeriodMs,
      stopBackground: async () => this.stopAll(client),
      detached: this.detached,
    });
    this.kept = kept;
    KEPT.set(kept.session, this);
    this.interruptingOwnTurn = false;
    this.route({
      message: (type) => {
        this.ownTurn(client, type);
      },
      controlRequest: (requestId, subtype) => {
        client.respondError(
          requestId,
          `No turn is running to answer ${subtype}.`,
        );
      },
      controlCancel: () => undefined,
      // A process that breaks the protocol between turns is not kept.
      violation: () => {
        this.detached(kept.session.end(), "claude-live.violation");
      },
      exit: () => undefined,
    });
    return kept.session;
  }

  /** A turn the CLI opened itself between stella's turns is interrupted. */
  private ownTurn(client: ClaudeCliClient, type: string) {
    if (type === "result") {
      this.interruptingOwnTurn = false;
      return;
    }
    if (!OWN_TURN_OUTPUT.has(type) || this.interruptingOwnTurn) {
      return;
    }
    this.interruptingOwnTurn = true;
    this.detached(
      settlesWithin(client.request("interrupt"), this.gracePeriodMs),
      "claude-live.interrupt",
    );
  }

  /** The CLI lists its live background tasks whenever the set changes. */
  private observe(type: string, raw: unknown) {
    if (type !== "system") {
      return;
    }
    const parsed = v.safeParse(BackgroundTasksChangedSchema, raw);
    if (!parsed.success) {
      return;
    }
    this.tasks = new Map(
      parsed.output.tasks.map((task) => [task.task_id, task.task_type]),
    );
    this.background.set(this.commands());
  }
}
