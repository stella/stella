import { panic, Result, TaggedError } from "better-result";
import * as v from "valibot";

import type { DetachedRejectionSink } from "@stll/errors";

import type { HarnessLiveSession } from "../adapter";
import { harnessSessionId } from "../events";
import {
  BackgroundTasks,
  keepLiveSession,
  type KeptSession,
} from "../live-session";
import type { Detached, HarnessTurnBackground } from "../turn-lifecycle";
import type { AppServerClient, AppServerHandlers } from "./app-server-client";
import {
  BackgroundTerminalsListResponseSchema,
  ItemCompletedSchema,
  ItemStartedSchema,
  METHOD_NOT_FOUND,
} from "./protocol";

/**
 * Codex's background work, across the turns one app-server process hosts.
 *
 * A command the agent leaves running (`exec_command` past its yield time) is a
 * background terminal of the thread: the app-server keeps it, the next turn
 * reads or writes it by its session id, and its `commandExecution` item
 * completes once the command exits, after the turn if need be. Terminals live
 * in the app-server process and end with it, so a turn that completes with
 * one running keeps the process (`keepLiveSession`) and the chat's next turn
 * starts in it. `thread/backgroundTerminals/clean` ends them before the
 * process closes, whatever process group or session a terminal runs in.
 */

/** Pages of background terminals read at most; each holds many. */
const MAX_TERMINAL_PAGES = 10;

/** The live sessions this adapter made, to continue a turn in. */
const KEPT = new WeakMap<HarnessLiveSession, CodexProcess>();

/**
 * Why the thread's background terminals could not be listed: the harness
 * has no such method (an older release, which keeps none past a turn), or
 * it failed to answer it, refused it otherwise or answered with a shape the
 * pinned protocol does not define.
 */
class CodexTerminalListError extends TaggedError("CodexTerminalListError")<{
  reason: "unsupported" | "failed";
  message: string;
}> {}

/** The item ids of the thread's background terminals. */
const listTerminals = async (
  client: AppServerClient,
  threadId: string,
): Promise<Result<ReadonlySet<string>, CodexTerminalListError>> => {
  const items = new Set<string>();
  let cursor: string | null = null;
  for (let page = 0; page < MAX_TERMINAL_PAGES; page += 1) {
    // await-in-loop: each page needs the previous page's cursor.
    const listed = await client.request(
      "thread/backgroundTerminals/list",
      cursor === null ? { threadId } : { threadId, cursor },
    );
    if (Result.isError(listed)) {
      return Result.err(
        new CodexTerminalListError({
          reason:
            listed.error.code === METHOD_NOT_FOUND ? "unsupported" : "failed",
          message: listed.error.message,
        }),
      );
    }
    const parsed = v.safeParse(
      BackgroundTerminalsListResponseSchema,
      listed.value,
    );
    if (!parsed.success) {
      return Result.err(
        new CodexTerminalListError({
          reason: "failed",
          message: "The harness listed its background terminals malformed.",
        }),
      );
    }
    for (const terminal of parsed.output.data) {
      items.add(terminal.itemId);
    }
    cursor = parsed.output.nextCursor;
    if (cursor === null) {
      break;
    }
  }
  return Result.ok(items);
};

const IGNORED: AppServerHandlers = {
  notification: () => undefined,
  request: () => undefined,
  violation: () => undefined,
  exit: () => undefined,
};

/**
 * One app-server process across the turns it hosts. Its messages go to the
 * turn that holds it. Between turns, while it is kept for work a turn left in
 * the background, requests are refused and notifications only count that
 * work down as its commands exit.
 */
export class CodexProcess {
  readonly background = new BackgroundTasks();
  /** The thread the process's turns run on, once it is open. */
  threadId: string | null = null;
  private target: AppServerHandlers = IGNORED;
  private attached: AppServerClient | null = null;
  /** Item ids of the background terminals last listed. */
  private terminals: ReadonlySet<string> = new Set();
  /** Items that completed while a list was on its way; `null` otherwise. */
  private completedWhileListing: Set<string> | null = null;
  /**
   * Command items started and not completed, as the notifications report
   * them: the inventory when the harness fails to list its terminals.
   */
  private readonly runningCommands = new Set<string>();
  private kept: KeptSession | null = null;
  private readonly gracePeriodMs: number;
  private readonly detached: Detached;
  private readonly reportError: DetachedRejectionSink;

  constructor(options: {
    gracePeriodMs: number;
    detached: Detached;
    /** Where a failure that changes nothing for the turn is reported. */
    reportError: DetachedRejectionSink;
  }) {
    this.gracePeriodMs = options.gracePeriodMs;
    this.detached = options.detached;
    this.reportError = options.reportError;
  }

  /** The process that keeps `session`, if this adapter made it. */
  static of(session: HarnessLiveSession): CodexProcess | undefined {
    return KEPT.get(session);
  }

  /** The handlers the process is started with. */
  readonly handlers: AppServerHandlers = {
    notification: (method, params) => {
      this.observe(method, params);
      this.target.notification(method, params);
    },
    request: (id, method, params) => {
      this.target.request(id, method, params);
    },
    violation: (message) => {
      this.target.violation(message);
    },
    exit: (exit) => {
      this.target.exit(exit);
    },
  };

  /** The started process; set once, right after it started. */
  attach(client: AppServerClient) {
    this.attached = client;
  }

  get client(): AppServerClient {
    return this.attached ?? panic("Codex process: used before it was attached");
  }

  /** Hand the process's messages to the turn that holds it now. */
  route(handlers: AppServerHandlers) {
    this.target = handlers;
  }

  /** The turn's end: keep the process for its background work, or end it. */
  readonly turnBackground: HarnessTurnBackground<AppServerClient> = {
    keep: async (client) => this.keep(client),
    stopBackground: async (client) => this.stop(client),
  };

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

  /** Ends every background terminal of the thread. */
  async stop(client: AppServerClient) {
    const threadId = this.threadId;
    if (threadId === null) {
      return;
    }
    // A harness without it (an older release) still ends with its process.
    (
      await client.request("thread/backgroundTerminals/clean", { threadId })
    ).unwrapOr(undefined);
  }

  private async keep(
    client: AppServerClient,
  ): Promise<HarnessLiveSession | null> {
    const threadId = this.threadId;
    if (threadId === null || (await this.refresh(client, threadId)) === 0) {
      return null;
    }
    const kept = keepLiveSession({
      harness: "codex",
      sessionId: harnessSessionId(threadId),
      process: client,
      background: this.background,
      gracePeriodMs: this.gracePeriodMs,
      stopBackground: async () => this.stop(client),
      detached: this.detached,
    });
    this.kept = kept;
    KEPT.set(kept.session, this);
    this.route({
      notification: () => undefined,
      request: (id, method) => {
        client.respondError(
          id,
          METHOD_NOT_FOUND,
          `No turn is running to answer ${method}.`,
        );
      },
      // A process that breaks the protocol between turns is not kept.
      violation: () => {
        this.detached(kept.session.end(), "codex-live.violation");
      },
      exit: () => undefined,
    });
    return kept.session;
  }

  /**
   * How many background terminals run now, read from the harness. A harness
   * without the list (an older release) keeps none past a turn. One that
   * fails to list them is reported, and the commands its notifications show
   * started and not completed stand in: a failed read is not an empty one,
   * and ending those commands would end work the agent still runs.
   */
  private async refresh(client: AppServerClient, threadId: string) {
    const completed = new Set<string>();
    this.completedWhileListing = completed;
    const listed = await listTerminals(client, threadId);
    this.completedWhileListing = null;
    const inventory = Result.isOk(listed)
      ? listed.value
      : this.inventoryWithout(listed.error);
    // A command that exited while the list was on its way is not running.
    this.terminals = new Set(
      [...inventory].filter((itemId) => !completed.has(itemId)),
    );
    this.background.set(this.terminals.size);
    return this.terminals.size;
  }

  /** What runs in the background when the harness did not list it. */
  private inventoryWithout(error: CodexTerminalListError): ReadonlySet<string> {
    if (error.reason === "unsupported") {
      return new Set();
    }
    this.reportError(error, "codex-live.list");
    return new Set(this.runningCommands);
  }

  /** A background terminal's item completes once its command exits. */
  private observe(method: string, params: unknown) {
    if (method === "item/started") {
      const started = v.safeParse(ItemStartedSchema, params);
      if (
        started.success &&
        started.output.item.type === "commandExecution" &&
        started.output.item.id !== undefined
      ) {
        this.runningCommands.add(started.output.item.id);
      }
      return;
    }
    if (method !== "item/completed") {
      return;
    }
    const parsed = v.safeParse(ItemCompletedSchema, params);
    const itemId = parsed.success ? parsed.output.item.id : undefined;
    if (itemId === undefined) {
      return;
    }
    this.runningCommands.delete(itemId);
    this.completedWhileListing?.add(itemId);
    if (!this.terminals.has(itemId)) {
      return;
    }
    const left = new Set(this.terminals);
    left.delete(itemId);
    this.terminals = left;
    this.background.set(left.size);
  }
}
