import { panic, Result } from "better-result";
import * as v from "valibot";

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

/** The item ids of the thread's background terminals; `null` if unread. */
const listTerminals = async (
  client: AppServerClient,
  threadId: string,
): Promise<ReadonlySet<string> | null> => {
  const items = new Set<string>();
  let cursor: string | null = null;
  for (let page = 0; page < MAX_TERMINAL_PAGES; page += 1) {
    // await-in-loop: each page needs the previous page's cursor.
    const listed = await client.request(
      "thread/backgroundTerminals/list",
      cursor === null ? { threadId } : { threadId, cursor },
    );
    const parsed = Result.isOk(listed)
      ? v.safeParse(BackgroundTerminalsListResponseSchema, listed.value)
      : null;
    // A harness without the list (an older release) keeps nothing running.
    if (parsed === null || !parsed.success) {
      return null;
    }
    for (const terminal of parsed.output.data) {
      items.add(terminal.itemId);
    }
    cursor = parsed.output.nextCursor;
    if (cursor === null) {
      return items;
    }
  }
  return items;
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
  private kept: KeptSession | null = null;
  private readonly gracePeriodMs: number;
  private readonly detached: Detached;

  constructor(options: { gracePeriodMs: number; detached: Detached }) {
    this.gracePeriodMs = options.gracePeriodMs;
    this.detached = options.detached;
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
    await client.request("thread/backgroundTerminals/clean", { threadId });
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

  /** How many background terminals run now, read from the harness. */
  private async refresh(client: AppServerClient, threadId: string) {
    const completed = new Set<string>();
    this.completedWhileListing = completed;
    const listed = await listTerminals(client, threadId);
    this.completedWhileListing = null;
    // A command that exited while the list was on its way is not running.
    this.terminals = new Set(
      [...(listed ?? [])].filter((itemId) => !completed.has(itemId)),
    );
    this.background.set(this.terminals.size);
    return this.terminals.size;
  }

  /** A background terminal's item completes once its command exits. */
  private observe(method: string, params: unknown) {
    if (method !== "item/completed") {
      return;
    }
    const parsed = v.safeParse(ItemCompletedSchema, params);
    const itemId = parsed.success ? parsed.output.item.id : undefined;
    if (itemId === undefined) {
      return;
    }
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
