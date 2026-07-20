/**
 * Minimal Docker Engine API client over a unix socket, using bun's native
 * `fetch({ unix })`. The whole point of this module is to avoid dockerode: its
 * container-attach path upgrades the HTTP connection (Connection: Upgrade →
 * 101 → raw socket hijack), and bun's `node:http` client does not emit the
 * `'upgrade'` event that hijack relies on, so dockerode's streaming exec fails
 * under bun.
 *
 * We sidestep that entirely: Docker's `POST /exec/{id}/start` returns the
 * multiplexed output as an ordinary chunked 200 response body when the request
 * is NOT hijacked. bun's `fetch` streams that body fine. The only cost is no
 * writable stdin over exec — which the harness adapters already handle by
 * advertising `writableStdin: false` and delivering the prompt via a file.
 */

import { TaggedError } from "better-result";

/** A Docker Engine API call failed (non-2xx, malformed response, …). */
export class DockerApiError extends TaggedError("DockerApiError")<{
  message: string;
}>() {}

/** A demultiplexed frame from Docker's non-TTY exec stream. */
export type ExecFrame = { stream: "stdout" | "stderr"; data: Uint8Array };

export type DockerConn = { socketPath: string };

const textDecoder = new TextDecoder();

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const dockerUrl = (path: string): string => `http://docker${path}`;

// bun's fetch accepts a `unix` socket path; the types ship with @types/bun.
type BunFetchInit = RequestInit & { unix?: string };

const send = async (
  conn: DockerConn,
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> => {
  const init: BunFetchInit = {
    method,
    unix: conn.socketPath,
    ...(body === undefined
      ? {}
      : {
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }),
  };
  return await fetch(dockerUrl(path), init);
};

const ensureOk = async (res: Response, what: string): Promise<Response> => {
  if (res.ok) {
    return res;
  }
  const detail = await res.text();
  throw new DockerApiError({
    message: `Docker API ${what} → HTTP ${res.status}: ${detail}`,
  });
};

const sendJson = async (
  conn: DockerConn,
  method: string,
  path: string,
  body?: unknown,
): Promise<unknown> => {
  const res = await ensureOk(
    await send(conn, method, path, body),
    `${method} ${path}`,
  );
  const text = await res.text();
  return text ? JSON.parse(text) : undefined;
};

/** Read a required string `Id` from a Docker API JSON response. */
const readId = (value: unknown): string => {
  if (isRecord(value) && typeof value["Id"] === "string") {
    return value["Id"];
  }
  throw new DockerApiError({
    message: "Docker API response missing a string `Id`",
  });
};

/**
 * Demultiplex Docker's 8-byte-framed non-TTY stream into stdout/stderr frames.
 * @yields one {@link ExecFrame} per whole Docker stream frame.
 */
export async function* demuxExecStream(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<ExecFrame> {
  const reader = body.getReader();
  let buffer = new Uint8Array(0);

  const append = (chunk: Uint8Array): void => {
    const next = new Uint8Array(buffer.length + chunk.length);
    next.set(buffer);
    next.set(chunk, buffer.length);
    buffer = next;
  };

  for (;;) {
    // Streaming reads are inherently sequential — each frame arrives after the
    // previous chunk is consumed; there is nothing to parallelize.
    // eslint-disable-next-line no-await-in-loop
    const { done, value } = await reader.read();
    if (value) {
      append(value);
      // Emit every whole frame currently buffered.
      for (;;) {
        if (buffer.length < 8) {
          break;
        }
        const header = new DataView(buffer.buffer, buffer.byteOffset, 8);
        const size = header.getUint32(4, false);
        if (buffer.length < 8 + size) {
          break;
        }
        const streamType = buffer[0];
        const payload = buffer.slice(8, 8 + size);
        buffer = buffer.slice(8 + size);
        yield { stream: streamType === 2 ? "stderr" : "stdout", data: payload };
      }
    }
    if (done) {
      break;
    }
  }
}

export type ExecCreateInput = {
  cmd: string[];
  workingDir: string;
  env: string[];
};

/** Create an exec instance in a container; returns its exec id. */
export const createExec = async (
  conn: DockerConn,
  containerId: string,
  input: ExecCreateInput,
): Promise<string> =>
  readId(
    await sendJson(conn, "POST", `/containers/${containerId}/exec`, {
      Cmd: input.cmd,
      AttachStdout: true,
      AttachStderr: true,
      WorkingDir: input.workingDir,
      Env: input.env,
    }),
  );

/** Start an exec non-hijacked and return the streaming multiplexed body. */
export const startExecStream = async (
  conn: DockerConn,
  execId: string,
  signal?: AbortSignal,
): Promise<ReadableStream<Uint8Array>> => {
  const init: BunFetchInit = {
    method: "POST",
    unix: conn.socketPath,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ Detach: false, Tty: false }),
    ...(signal ? { signal } : {}),
  };
  const res = await ensureOk(
    await fetch(dockerUrl(`/exec/${execId}/start`), init),
    `POST /exec/${execId}/start`,
  );
  if (!res.body) {
    throw new DockerApiError({
      message: "Docker exec start returned no response body",
    });
  }
  return res.body;
};

/** Exit code of a finished exec (Docker reports null while still running). */
export const inspectExecExitCode = async (
  conn: DockerConn,
  execId: string,
): Promise<number> => {
  const info = await sendJson(conn, "GET", `/exec/${execId}/json`);
  const exitCode = isRecord(info) ? info["ExitCode"] : undefined;
  return typeof exitCode === "number" ? exitCode : 0;
};

export const decodeFrames = (frames: Uint8Array[]): string =>
  textDecoder.decode(concatBytes(frames));

const concatBytes = (parts: Uint8Array[]): Uint8Array => {
  const total = parts.reduce((sum, p) => sum + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
};

export const decodeChunk = (chunk: Uint8Array): string =>
  textDecoder.decode(chunk);

// --- Container lifecycle ---------------------------------------------------

export type CreateContainerInput = {
  image: string;
  workdir: string;
  cmd: string[];
  env?: string[];
  hostGateway: boolean;
  /**
   * Pin the container onto a specific Docker network (maps to
   * `HostConfig.NetworkMode`). Omit to use the daemon default bridge.
   * Deployments that must constrain egress point this at a locked-down network
   * (e.g. an internal network fronted by an egress allowlist) so a run cannot
   * open arbitrary outbound connections and exfiltrate injected secrets.
   */
  networkMode?: string;
};

export const createContainer = async (
  conn: DockerConn,
  input: CreateContainerInput,
): Promise<string> =>
  readId(
    await sendJson(conn, "POST", "/containers/create", {
      Image: input.image,
      Cmd: input.cmd,
      Tty: false,
      WorkingDir: input.workdir,
      ...(input.env ? { Env: input.env } : {}),
      HostConfig: {
        ...(input.hostGateway
          ? { ExtraHosts: ["host.docker.internal:host-gateway"] }
          : {}),
        ...(input.networkMode ? { NetworkMode: input.networkMode } : {}),
      },
    }),
  );

export const startContainer = async (
  conn: DockerConn,
  containerId: string,
): Promise<void> => {
  await ensureOk(
    await send(conn, "POST", `/containers/${containerId}/start`),
    `start ${containerId}`,
  );
};

export const inspectContainerRunning = async (
  conn: DockerConn,
  containerId: string,
): Promise<boolean | null> => {
  const res = await send(conn, "GET", `/containers/${containerId}/json`);
  if (res.status === 404) {
    return null;
  }
  const info: unknown = await (
    await ensureOk(res, `inspect ${containerId}`)
  ).json();
  const state = isRecord(info) ? info["State"] : undefined;
  return isRecord(state) && state["Running"] === true;
};

export const stopContainer = async (
  conn: DockerConn,
  containerId: string,
): Promise<void> => {
  // Best-effort: a stopped/removed container is not an error to the caller.
  await send(conn, "POST", `/containers/${containerId}/stop?t=5`);
};

export const removeContainer = async (
  conn: DockerConn,
  containerId: string,
): Promise<void> => {
  await send(conn, "DELETE", `/containers/${containerId}?force=true&v=true`);
};

/** Commit a container to a new image `repo:tag`; returns the image id. */
export const commitContainer = async (
  conn: DockerConn,
  containerId: string,
  repo: string,
  tag: string,
): Promise<string> => {
  const params = new URLSearchParams({ container: containerId, repo, tag });
  return readId(await sendJson(conn, "POST", `/commit?${params.toString()}`));
};

/** Remove an image (best-effort; used to clean up snapshot images). */
export const removeImage = async (
  conn: DockerConn,
  image: string,
): Promise<void> => {
  await send(conn, "DELETE", `/images/${encodeURIComponent(image)}?force=true`);
};

export const imageExists = async (
  conn: DockerConn,
  image: string,
): Promise<boolean> => {
  const res = await send(
    conn,
    "GET",
    `/images/${encodeURIComponent(image)}/json`,
  );
  return res.ok;
};

const parseProgressLine = (line: string): unknown => {
  try {
    return JSON.parse(line);
  } catch {
    // Non-JSON progress noise: ignore and keep scanning for an error object.
    return undefined;
  }
};

/** Pull an image, draining the progress stream and surfacing pull errors. */
export const pullImage = async (
  conn: DockerConn,
  image: string,
): Promise<void> => {
  const res = await ensureOk(
    await send(
      conn,
      "POST",
      `/images/create?fromImage=${encodeURIComponent(image)}`,
    ),
    `pull ${image}`,
  );
  // `/images/create` answers 200 immediately, then streams newline-delimited
  // JSON progress. A pull failure (auth, rate limit, missing tag) arrives as
  // an `{ "error": … }` object IN that body, not as a non-2xx status — so
  // draining without inspecting would silently succeed. Scan for the error.
  const body = await res.text();
  for (const line of body.split("\n")) {
    if (line.trim() === "") {
      continue;
    }
    const parsed = parseProgressLine(line);
    if (isRecord(parsed) && typeof parsed["error"] === "string") {
      throw new DockerApiError({
        message: `Docker pull failed for ${image}: ${parsed["error"]}`,
      });
    }
  }
};
