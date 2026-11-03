import { EventType } from "@tanstack/ai";
import { panic } from "better-result";
import { timingSafeEqual } from "node:crypto";
import { Temporal } from "temporal-polyfill/full";

import type { AgentHarness } from "@stll/api-contract/agent-harness";
import { createDetached } from "@stll/errors";

import { SidecarHost } from "./host";
import {
  encodeSidecarMessage,
  parseSidecarHelloPreamble,
  parseSidecarHostLine,
  SIDECAR_MAX_HELD_RUNS,
  SIDECAR_PROTOCOL,
  type SidecarHolderMode,
  type SidecarHostHello,
  type SidecarHostOutput,
  type SidecarMessage,
  type SidecarRejection,
  type SidecarRunMessage,
  type SidecarRunOutput,
} from "./protocol";

/**
 * The holder: the sidecar's process-level state between the command loop
 * (`host.ts`) and whichever desktop is connected. It outlives the desktop,
 * so runs keep going while the app is closed, restarting or updating.
 *
 * - It numbers every per-run message (`seq`, from 1 per run) and keeps each
 *   until the desktop acknowledges it, so a desktop that reconnects resumes
 *   exactly where its upstream stopped storing.
 * - A run's kept messages are bounded by the runner's per-run storage
 *   limits. A run that outgrows them is cancelled and ends as `failed` with a
 *   `sidecar.buffer_full` error chunk; those two messages may pass the bound.
 * - A finished run is forgotten once its last message is acknowledged, or
 *   when no desktop collected it within the API's abandoned-run window.
 * - It exits on `shutdown` (cancelling every run), once drained (no run held
 *   after `drain`), or after `idleExitMs` with no run held and no desktop.
 */

/** No run held and no desktop connected for this long ends the holder. */
export const HOLDER_IDLE_EXIT_MS = 10 * 60_000;
/** A connection that has not authenticated within this is closed. */
export const HOLDER_HELLO_TIMEOUT_MS = 10_000;
/**
 * How long a finished run waits for a desktop to collect it: the API ends a
 * run whose computer has not returned within a day as lost.
 */
export const HOLDER_UNACKED_RETENTION_MS = 24 * 60 * 60_000;
/**
 * The runner contract's per-run storage limits (messages, UTF-8 bytes): a
 * run the API would refuse to store is not worth holding either.
 */
export const HOLDER_RUN_LIMITS = {
  maxMessages: 20_000,
  maxBytes: 64 * 1024 * 1024,
} as const satisfies HolderRunLimits;

const BUFFER_FULL_CODE = "sidecar.buffer_full";

export type HolderRunLimits = {
  readonly maxMessages: number;
  readonly maxBytes: number;
};

export type HolderOptions = {
  sidecarVersion: string;
  /** The hex secret a desktop must present in `hello`. */
  secret: string;
  /** One line in the holder's log. Never passed tokens, prompts or outputs. */
  log: (line: string) => void;
  /** The harness's environment; `CODEX_HOME` and the like are set per run. */
  environment: Readonly<Record<string, string>>;
  idleExitMs: number;
  helloTimeoutMs: number;
  unackedRetentionMs: number;
  limits: HolderRunLimits;
  /** Called once, after every run stopped: the process may exit. */
  exit: () => void;
};

/** One accepted socket, as the transport sees it. */
export type HolderConnection = {
  write: (line: string) => void;
  close: () => void;
};

/** What the transport tells the holder about one connection. */
export type HolderPeer = {
  line: (line: string) => void;
  /** The connection sent a line over the limit; its rest is skipped. */
  tooLarge: () => void;
  closed: () => void;
};

type Kept = { seq: number; line: string; bytes: number };

type RunStatus = "running" | "overflowed" | "finished";

type Journal = {
  harness: AgentHarness;
  threadId: string;
  model: string;
  status: RunStatus;
  lastSeq: number;
  /** Unacknowledged messages, in `seq` order. */
  kept: Kept[];
  keptBytes: number;
  expiry: ReturnType<typeof setTimeout> | null;
};

type Peer = {
  connection: HolderConnection;
  status: "pending" | "authenticated" | "closed";
  /** Runs whose messages stream to this connection. */
  attached: Set<string>;
  helloTimer: ReturnType<typeof setTimeout> | null;
};

const secretsMatch = (presented: string, held: string) => {
  const left = Buffer.from(presented);
  const right = Buffer.from(held);
  return left.length === right.length && timingSafeEqual(left, right);
};

export class Holder {
  private readonly options: HolderOptions;
  private readonly host: SidecarHost;
  private readonly journals = new Map<string, Journal>();
  private current: Peer | null = null;
  private mode: SidecarHolderMode = "serving";
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private exiting = false;
  private readonly detached: ReturnType<typeof createDetached>;

  constructor(options: HolderOptions) {
    this.options = options;
    this.detached = createDetached((_error, context) => {
      options.log(`background work failed: ${context}`);
    });
    this.host = new SidecarHost({
      send: (message) => {
        this.fromHost(message);
      },
      log: options.log,
      environment: options.environment,
    });
    this.settle();
  }

  /** Start talking to a new connection. */
  accept(connection: HolderConnection): HolderPeer {
    const peer: Peer = {
      connection,
      status: "pending",
      attached: new Set(),
      helloTimer: null,
    };
    peer.helloTimer = setTimeout(() => {
      this.options.log("closed a connection that did not authenticate");
      this.close(peer);
    }, this.options.helloTimeoutMs);
    return {
      line: (line) => {
        if (peer.status === "pending") {
          this.authenticate(peer, line);
        } else if (peer.status === "authenticated") {
          this.command(peer, line);
        }
      },
      tooLarge: () => {
        if (peer.status === "authenticated") {
          this.write(peer, {
            type: "rejected",
            reason: "too_large",
            messageType: null,
            runId: null,
          });
        } else {
          this.close(peer);
        }
      },
      closed: () => {
        this.closed(peer);
      },
    };
  }

  /** Cancel every run, let each finish, and exit. */
  stop() {
    this.detached(this.halt(), "holder.stop");
  }

  private async halt() {
    if (this.exiting) {
      return;
    }
    this.exiting = true;
    if (this.idleTimer !== null) {
      clearTimeout(this.idleTimer);
    }
    await this.host.shutdown();
    for (const journal of this.journals.values()) {
      if (journal.expiry !== null) {
        clearTimeout(journal.expiry);
      }
    }
    if (this.current !== null) {
      this.close(this.current);
    }
    this.options.exit();
  }

  private authenticate(peer: Peer, line: string) {
    const preamble = parseSidecarHelloPreamble(line);
    if (
      preamble === null ||
      !secretsMatch(preamble.secret, this.options.secret)
    ) {
      this.options.log("closed a connection without the holder secret");
      this.close(peer);
      return;
    }
    const refuse = (reason: SidecarRejection) => {
      this.write(peer, this.rejection(reason, "hello"));
      this.close(peer);
    };
    if (preamble.protocol !== SIDECAR_PROTOCOL) {
      refuse("protocol_mismatch");
      return;
    }
    const parsed = parseSidecarHostLine(line);
    if (parsed.type !== "message" || parsed.message.type !== "hello") {
      refuse("invalid");
      return;
    }
    const hello: SidecarHostHello = parsed.message;
    if (!this.host.configure(hello.appVersion, hello.apiOrigin)) {
      refuse("origin_mismatch");
      return;
    }
    if (peer.helloTimer !== null) {
      clearTimeout(peer.helloTimer);
      peer.helloTimer = null;
    }
    if (this.current !== null) {
      this.options.log("a new desktop connection replaced the previous one");
      this.close(this.current);
    }
    peer.status = "authenticated";
    this.current = peer;
    this.settle();
    this.write(peer, {
      type: "hello",
      protocol: SIDECAR_PROTOCOL,
      sidecarVersion: this.options.sidecarVersion,
      mode: this.mode,
      runs: [...this.journals].map(([runId, journal]) => ({
        runId,
        harness: journal.harness,
        lastSeq: journal.lastSeq,
      })),
    });
    for (const point of hello.resume) {
      this.resume(peer, point.runId, point.afterSeq, "hello");
    }
  }

  private command(peer: Peer, line: string) {
    const parsed = parseSidecarHostLine(line);
    if (parsed.type === "rejected") {
      this.write(peer, this.rejection(parsed.reason, parsed.messageType));
      return;
    }
    const message = parsed.message;
    switch (message.type) {
      case "hello":
        this.write(peer, this.rejection("hello_repeated", message.type));
        return;
      case "ack":
        this.ack(peer, message.runId, message.seq);
        return;
      case "resume":
        this.resume(peer, message.runId, message.afterSeq, message.type);
        return;
      case "drain":
        this.mode = "draining";
        this.options.log("draining: taking no new runs");
        this.settle();
        return;
      case "shutdown":
        this.stop();
        return;
      case "run.start": {
        if (this.mode === "draining") {
          this.write(
            peer,
            this.rejection("draining", message.type, message.runId),
          );
          return;
        }
        if (this.journals.has(message.runId)) {
          this.write(
            peer,
            this.rejection("duplicate_run", message.type, message.runId),
          );
          return;
        }
        if (this.journals.size >= SIDECAR_MAX_HELD_RUNS) {
          this.write(
            peer,
            this.rejection("at_capacity", message.type, message.runId),
          );
          return;
        }
        this.journals.set(message.runId, {
          harness: message.harness,
          threadId: message.threadId,
          model: message.model,
          status: "running",
          lastSeq: 0,
          kept: [],
          keptBytes: 0,
          expiry: null,
        });
        peer.attached.add(message.runId);
        this.settle();
        this.host.handle(message);
        return;
      }
      case "harness.probe":
      case "run.approval":
      case "run.interrupt":
      case "run.cancel":
      case "run.token":
        this.host.handle(message);
        return;
      default:
        message satisfies never;
        panic("Unhandled sidecar host message");
    }
  }

  private ack(peer: Peer, runId: string, seq: number) {
    const journal = this.journals.get(runId);
    if (journal === undefined) {
      this.write(peer, this.rejection("unknown_run", "ack", runId));
      return;
    }
    const through = Math.min(seq, journal.lastSeq);
    const dropped = journal.kept.findIndex((kept) => kept.seq > through);
    const removed = journal.kept.splice(
      0,
      dropped === -1 ? journal.kept.length : dropped,
    );
    for (const kept of removed) {
      journal.keptBytes -= kept.bytes;
    }
    if (journal.status === "finished" && journal.kept.length === 0) {
      this.forget(runId, journal);
    }
  }

  private resume(
    peer: Peer,
    runId: string,
    afterSeq: number,
    messageType: "hello" | "resume",
  ) {
    const journal = this.journals.get(runId);
    if (journal === undefined) {
      this.write(peer, this.rejection("unknown_run", messageType, runId));
      return;
    }
    for (const kept of journal.kept) {
      if (kept.seq > afterSeq) {
        peer.connection.write(kept.line);
      }
    }
    peer.attached.add(runId);
  }

  private fromHost(message: SidecarHostOutput) {
    if (
      message.type !== "run.event" &&
      message.type !== "run.approval_request" &&
      message.type !== "run.finished"
    ) {
      if (this.current !== null) {
        this.write(this.current, message);
      }
      return;
    }
    const journal =
      this.journals.get(message.runId) ??
      panic("The command loop sent a message for a run the holder never took");
    if (journal.status === "finished") {
      panic("The command loop sent a message after a run finished");
    }
    if (journal.status === "overflowed") {
      if (message.type === "run.finished") {
        this.record(
          message.runId,
          journal,
          this.bufferFull(message.runId, journal),
        );
        this.record(message.runId, journal, { ...message, outcome: "failed" });
      }
      return;
    }
    this.record(message.runId, journal, message);
  }

  /** Number, keep and stream one run message. */
  private record(runId: string, journal: Journal, message: SidecarRunOutput) {
    const numbered: SidecarRunMessage = {
      ...message,
      seq: journal.lastSeq + 1,
    };
    const line = encodeSidecarMessage(numbered);
    if (line === null) {
      // Only a chunk can outgrow a line; a run's last message never does.
      this.options.log(`dropped an oversized ${message.type} message`);
      return;
    }
    const bytes = Buffer.byteLength(line);
    const limits = this.options.limits;
    if (
      journal.status === "running" &&
      message.type !== "run.finished" &&
      (journal.kept.length + 1 > limits.maxMessages ||
        journal.keptBytes + bytes > limits.maxBytes)
    ) {
      this.options.log("a run outgrew the holder's buffer; cancelling it");
      journal.status = "overflowed";
      this.host.cancel(runId);
      return;
    }
    journal.lastSeq = numbered.seq;
    journal.kept.push({ seq: numbered.seq, line, bytes });
    journal.keptBytes += bytes;
    const current = this.current;
    if (current?.attached.has(runId) === true) {
      current.connection.write(line);
    }
    if (message.type === "run.finished") {
      journal.status = "finished";
      journal.expiry = setTimeout(() => {
        this.options.log("forgot a finished run no desktop collected");
        this.forget(runId, journal);
      }, this.options.unackedRetentionMs);
    }
  }

  /** The error chunk that ends a run the holder could no longer buffer. */
  private bufferFull(runId: string, journal: Journal): SidecarRunOutput {
    const message = "The run produced more output than the holder can keep.";
    return {
      type: "run.event",
      runId,
      chunk: {
        type: EventType.RUN_ERROR,
        runId,
        threadId: journal.threadId,
        model: journal.model,
        timestamp: Temporal.Now.instant().epochMilliseconds,
        message,
        code: BUFFER_FULL_CODE,
        error: { message, code: BUFFER_FULL_CODE },
      },
    };
  }

  private forget(runId: string, journal: Journal) {
    if (journal.expiry !== null) {
      clearTimeout(journal.expiry);
    }
    this.journals.delete(runId);
    this.current?.attached.delete(runId);
    this.settle();
  }

  private closed(peer: Peer) {
    if (peer.helloTimer !== null) {
      clearTimeout(peer.helloTimer);
      peer.helloTimer = null;
    }
    peer.status = "closed";
    if (this.current === peer) {
      this.current = null;
      this.settle();
    }
  }

  private close(peer: Peer) {
    peer.connection.close();
    this.closed(peer);
  }

  /** Exit once drained; arm or disarm the idle exit. */
  private settle() {
    if (this.exiting) {
      return;
    }
    if (this.mode === "draining" && this.journals.size === 0) {
      this.options.log("drained: exiting");
      this.stop();
      return;
    }
    const idle = this.current === null && this.journals.size === 0;
    if (!idle && this.idleTimer !== null) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    if (idle && this.idleTimer === null) {
      this.idleTimer = setTimeout(() => {
        this.options.log("idle: exiting");
        this.stop();
      }, this.options.idleExitMs);
    }
  }

  private rejection(
    reason: SidecarRejection,
    messageType: string | null,
    runId: string | null = null,
  ): Extract<SidecarMessage, { type: "rejected" }> {
    this.options.log(`rejected a host line: ${reason}`);
    return { type: "rejected", reason, messageType, runId };
  }

  private encode(message: SidecarMessage) {
    return (
      encodeSidecarMessage(message) ??
      panic(`A ${message.type} message outgrew the line limit`)
    );
  }

  /** An unnumbered message; run messages go through `record`. */
  private write(
    peer: Peer,
    message: Exclude<SidecarMessage, SidecarRunMessage>,
  ) {
    if (peer.status !== "closed") {
      peer.connection.write(this.encode(message));
    }
  }
}
