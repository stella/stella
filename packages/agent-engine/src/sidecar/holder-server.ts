import { Result } from "better-result";
import { randomBytes } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import net from "node:net";
import path from "node:path";
import { Temporal } from "temporal-polyfill/full";

import { Holder, type HolderOptions, type HolderPeer } from "./holder";
import { SIDECAR_MAX_LINE_BYTES } from "./protocol";

/**
 * The holder's transport and files. One folder per sidecar version, which
 * the desktop finds again after a restart, holds:
 *
 * - `holder.secret`: 32 random bytes as hex, mode 0600, written after the
 *   holder owns the endpoint; a desktop presents it in `hello`;
 * - `endpoint`: the endpoint the holder listens on, mode 0600, written
 *   after it owns the endpoint, so a desktop whose environment names
 *   another runtime folder still finds it;
 * - `holder.log`: the holder's log, rotated once at `MAX_LOG_BYTES`.
 *
 * The secret and the endpoint file are written atomically and removed on
 * exit. The endpoint is the path the desktop passes, never derived here: a
 * Unix socket in the user's short runtime folder (Windows: a named pipe). A
 * socket path must fit `sun_path`, so a longer one is refused rather than
 * shortened.
 *
 * On Unix the version folder and the socket's folder must belong to the
 * user and be closed to group and others (0700), so only the user reaches
 * the socket and the secret. On Windows the per-user app data folder
 * carries the same restriction.
 */

export const HOLDER_SECRET_FILE = "holder.secret";
export const HOLDER_ENDPOINT_FILE = "endpoint";
export const HOLDER_LOG_FILE = "holder.log";

const MAX_LOG_BYTES = 1024 * 1024;
const SECRET_BYTES = 32;
const IS_WINDOWS = process.platform === "win32";
/** `sun_path` bytes, its terminating NUL included. */
export const SUN_PATH_BYTES = process.platform === "linux" ? 108 : 104;

export type HolderStartError =
  | { reason: "insecure_dir"; message: string }
  | { reason: "endpoint_too_long"; message: string }
  | { reason: "insecure_endpoint"; message: string }
  | { reason: "already_running"; message: string }
  | { reason: "listen_failed"; message: string };

export type HolderServerOptions = Omit<
  HolderOptions,
  "secret" | "log" | "exit"
> & {
  /** The version's folder, `<app data>/agent-holder/<version>`. */
  dir: string;
  /** The socket path, or the named pipe on Windows, as the desktop chose. */
  endpoint: string;
};

/** Whether a folder is the user's alone: not a symlink, mode 0700 or less. */
const isPrivate = (dir: string) => {
  const stat = lstatSync(dir, { throwIfNoEntry: false });
  // The low six mode bits are the group's and others' permissions.
  return (
    stat !== undefined &&
    stat.isDirectory() &&
    stat.uid === process.getuid?.() &&
    stat.mode % 0o100 === 0
  );
};

/** Refuse a socket path that does not fit or sits in a shared folder. */
const usableEndpoint = (endpoint: string): Result<void, HolderStartError> => {
  if (IS_WINDOWS) {
    return Result.ok();
  }
  const bytes = Buffer.byteLength(endpoint);
  const limit = SUN_PATH_BYTES - 1;
  if (bytes > limit) {
    return Result.err({
      reason: "endpoint_too_long",
      message: `The socket path is ${bytes} bytes; at most ${limit} fit.`,
    });
  }
  if (!isPrivate(path.dirname(endpoint))) {
    return Result.err({
      reason: "insecure_endpoint",
      message: "The socket folder is not private to this user.",
    });
  }
  return Result.ok();
};

export type HolderServer = {
  holder: Holder;
  /** Settles once the holder stopped and the endpoint is closed. */
  exited: Promise<null>;
};

/** Create the folder 0700, or refuse one another user or group can reach. */
const privateDir = (dir: string): Result<void, HolderStartError> => {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (IS_WINDOWS) {
    return Result.ok();
  }
  if (!isPrivate(dir)) {
    return Result.err({
      reason: "insecure_dir",
      message: "The holder folder is not private to this user.",
    });
  }
  return Result.ok();
};

/** Appends lines to the log file, moving a full one to `holder.log.1`. */
const fileLog = (dir: string) => {
  const file = path.join(dir, HOLDER_LOG_FILE);
  let size = existsSync(file) ? statSync(file).size : 0;
  return (line: string) => {
    const text = `${Temporal.Now.instant().toString()} ${line}\n`;
    const bytes = Buffer.byteLength(text);
    if (size > 0 && size + bytes > MAX_LOG_BYTES) {
      renameSync(file, `${file}.1`);
      size = 0;
    }
    appendFileSync(file, text, { mode: 0o600 });
    size += bytes;
  };
};

/** Write a file atomically, readable by the user alone. */
const writePrivate = (dir: string, name: string, text: string) => {
  const file = path.join(dir, name);
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, text, { mode: 0o600 });
  renameSync(temporary, file);
};

const listen = async (server: net.Server, endpoint: string) =>
  new Promise<NodeJS.ErrnoException | null>((resolve) => {
    const failed = (error: NodeJS.ErrnoException) => {
      resolve(error);
    };
    server.once("error", failed);
    server.listen(endpoint, () => {
      server.off("error", failed);
      resolve(null);
    });
  });

/** Whether a holder answers on the endpoint. */
const answers = async (endpoint: string) =>
  new Promise<boolean>((resolve) => {
    const probe = net.connect(endpoint);
    probe.once("connect", () => {
      probe.destroy();
      resolve(true);
    });
    probe.once("error", () => {
      resolve(false);
    });
  });

/**
 * Own the endpoint. A socket file nobody answers on is a crashed holder's
 * and is replaced; a live holder means this one is not needed.
 */
const own = async (
  server: net.Server,
  endpoint: string,
): Promise<Result<void, HolderStartError>> => {
  const first = await listen(server, endpoint);
  if (first === null) {
    return Result.ok();
  }
  if (first.code !== "EADDRINUSE" || IS_WINDOWS || (await answers(endpoint))) {
    return Result.err(
      first.code === "EADDRINUSE"
        ? { reason: "already_running", message: "A holder already runs." }
        : { reason: "listen_failed", message: first.code ?? "unknown" },
    );
  }
  rmSync(endpoint, { force: true });
  const second = await listen(server, endpoint);
  return second === null
    ? Result.ok()
    : Result.err({
        reason: "listen_failed",
        message: second.code ?? "unknown",
      });
};

/** Feeds a connection's bytes to the holder as complete lines. */
const lineReader = (peer: HolderPeer) => {
  const decoder = new TextDecoder();
  let buffer = "";
  /** Discarding the rest of a line that already exceeded the limit. */
  let skipping = false;
  return (bytes: Uint8Array) => {
    buffer += decoder.decode(bytes, { stream: true });
    let newline = buffer.indexOf("\n");
    while (newline !== -1) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf("\n");
      if (skipping) {
        skipping = false;
        continue;
      }
      if (line.trim() !== "") {
        peer.line(line);
      }
    }
    if (buffer.length > SIDECAR_MAX_LINE_BYTES) {
      peer.tooLarge();
      buffer = "";
      skipping = true;
    }
  };
};

export const startHolderServer = async (
  options: HolderServerOptions,
): Promise<Result<HolderServer, HolderStartError>> => {
  const { dir, endpoint, ...holderOptions } = options;
  const folder = privateDir(dir);
  if (Result.isError(folder)) {
    return folder;
  }
  const log = fileLog(dir);
  const endpointCheck = usableEndpoint(endpoint);
  if (Result.isError(endpointCheck)) {
    log(
      `did not start: ${endpointCheck.error.reason}: ${endpointCheck.error.message}`,
    );
    return endpointCheck;
  }
  const server = net.createServer();
  const owned = await own(server, endpoint);
  if (Result.isError(owned)) {
    log(`did not start: ${owned.error.reason}`);
    return owned;
  }
  const secret = randomBytes(SECRET_BYTES).toString("hex");
  writePrivate(dir, HOLDER_SECRET_FILE, secret);
  writePrivate(dir, HOLDER_ENDPOINT_FILE, endpoint);
  const { promise: exited, resolve } = Promise.withResolvers<null>();
  const sockets = new Set<net.Socket>();
  /** Flush what was written, then drop the connection. */
  const end = (socket: net.Socket) => {
    socket.end(() => {
      socket.destroy();
    });
  };
  const holder = new Holder({
    ...holderOptions,
    secret,
    log,
    exit: () => {
      for (const socket of sockets) {
        end(socket);
      }
      server.close(() => {
        rmSync(path.join(dir, HOLDER_SECRET_FILE), { force: true });
        rmSync(path.join(dir, HOLDER_ENDPOINT_FILE), { force: true });
        if (!IS_WINDOWS) {
          rmSync(endpoint, { force: true });
        }
        resolve(null);
      });
    },
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    const peer = holder.accept({
      write: (line) => {
        socket.write(line);
      },
      close: () => {
        end(socket);
      },
    });
    const read = lineReader(peer);
    socket.on("data", read);
    socket.on("error", () => {
      socket.destroy();
    });
    socket.on("close", () => {
      sockets.delete(socket);
      peer.closed();
    });
  });
  log(`listening as ${holderOptions.sidecarVersion}`);
  return Result.ok({ holder, exited });
};
