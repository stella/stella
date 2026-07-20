import {
  createExecBackedGit,
  UnsupportedCapabilityError,
  type ExecResult,
  type ProcessOptions,
  type SandboxCapabilities,
  type SandboxCreateInput,
  type SandboxHandle,
  type SandboxProvider,
  type SandboxResumeInput,
  type SpawnHandle,
} from "@tanstack/ai-sandbox";

import {
  commitContainer,
  createContainer,
  createExec,
  decodeChunk,
  decodeFrames,
  demuxExecStream,
  DockerApiError,
  imageExists,
  inspectContainerRunning,
  inspectExecExitCode,
  pullImage,
  removeContainer,
  startContainer,
  startExecStream,
  stopContainer,
  type DockerConn,
} from "./api";

const DEFAULT_WORKDIR = "/workspace";
const KEEP_ALIVE_CMD = ["sh", "-c", "tail -f /dev/null"];
const SNAPSHOT_REPO = "stella-agent-sandbox-snapshot";

// Process-local counter for unique snapshot image tags (avoids Date.now()).
let snapshotSeq = 0;

/**
 * Capabilities of the bun-native Docker provider. `writableStdin` is false by
 * design: exec output streams over a plain (non-hijacked) response body, which
 * has no host→process stdin, so harness adapters deliver the prompt via a file
 * (they already branch on this flag). Snapshots use image commit; ports/fork
 * are out of scope for v1. `networkPolicy` is false because Docker's
 * `HostConfig` cannot express per-connection egress allowlisting; egress is
 * constrained at the network layer instead (see `config.networkMode`), so the
 * policy's `network: "deny"` is defense-in-depth, not the sole control.
 */
const BUN_DOCKER_CAPS: SandboxCapabilities = {
  fs: true,
  exec: true,
  env: true,
  ports: false,
  backgroundProcesses: true,
  writableStdin: false,
  snapshots: true,
  networkPolicy: false,
  durableFilesystem: true,
  fork: false,
};

export type BunDockerSandboxConfig = {
  image: string;
  workdir?: string;
  /** Docker daemon unix socket. Defaults to `/var/run/docker.sock`. */
  socketPath?: string;
  /** Add `host.docker.internal:host-gateway` for host-side MCP bridging. */
  hostGateway?: boolean;
  /**
   * Pin the container onto a specific Docker network (`HostConfig.NetworkMode`).
   * Omit to use the daemon default bridge. Set this to a locked-down network to
   * deny the run arbitrary egress (the harness reaches stella only via the
   * bridged MCP server), so an injected MCP token or harness key cannot be
   * exfiltrated over unrestricted outbound connections.
   */
  networkMode?: string;
  /** Remove the container on destroy (vs. just stop). Defaults to true. */
  removeOnDestroy?: boolean;
};

const shellQuote = (value: string): string =>
  `'${value.replaceAll("'", "'\\''")}'`;

const toContainerPath = (workdir: string, p: string): string => {
  if (workdir === DEFAULT_WORKDIR) {
    return p;
  }
  if (p === DEFAULT_WORKDIR) {
    return workdir;
  }
  if (p.startsWith(`${DEFAULT_WORKDIR}/`)) {
    return `${workdir}/${p.slice(DEFAULT_WORKDIR.length + 1)}`;
  }
  return p;
};

/** Push-based async queue backing a spawned process's stdout/stderr. */
class StreamQueue {
  private readonly items: string[] = [];
  private resolvers: ((r: IteratorResult<string>) => void)[] = [];
  private done = false;

  push(item: string): void {
    const resolve = this.resolvers.shift();
    if (resolve) {
      resolve({ value: item, done: false });
      return;
    }
    this.items.push(item);
  }

  close(): void {
    this.done = true;
    for (const resolve of this.resolvers) {
      resolve({ value: undefined, done: true });
    }
    this.resolvers = [];
  }

  async *iterate(): AsyncGenerator<string> {
    for (;;) {
      const buffered = this.items.shift();
      if (buffered !== undefined) {
        yield buffered;
        continue;
      }
      if (this.done) {
        return;
      }
      // Sequential by nature: block until the next push/close resolves.
      // eslint-disable-next-line no-await-in-loop
      const result = await new Promise<IteratorResult<string>>((resolve) => {
        this.resolvers.push(resolve);
      });
      if (result.done === true) {
        return;
      }
      yield result.value;
    }
  }
}

type HandleDeps = {
  conn: DockerConn;
  containerId: string;
  workdir: string;
  removeOnDestroy: boolean;
};

const createBunDockerHandle = (deps: HandleDeps): SandboxHandle => {
  const { conn, containerId, workdir } = deps;
  const envVars: Record<string, string> = {};

  const abs = (p: string): string => toContainerPath(workdir, p);
  const envArray = (extra?: Record<string, string>): string[] =>
    Object.entries({ ...envVars, ...extra }).map(([k, v]) => `${k}=${v}`);

  const exec = async (
    command: string,
    opts?: ProcessOptions,
  ): Promise<ExecResult> => {
    const execId = await createExec(conn, containerId, {
      cmd: ["sh", "-c", command],
      workingDir: opts?.cwd ? abs(opts.cwd) : workdir,
      env: envArray(opts?.env),
    });
    const body = await startExecStream(conn, execId, opts?.signal);
    const out: Uint8Array[] = [];
    const err: Uint8Array[] = [];
    for await (const frame of demuxExecStream(body)) {
      (frame.stream === "stdout" ? out : err).push(frame.data);
    }
    return {
      stdout: decodeFrames(out),
      stderr: decodeFrames(err),
      exitCode: await inspectExecExitCode(conn, execId),
    };
  };

  const spawn = async (
    command: string,
    opts?: ProcessOptions,
  ): Promise<SpawnHandle> => {
    const execId = await createExec(conn, containerId, {
      cmd: ["sh", "-c", command],
      workingDir: opts?.cwd ? abs(opts.cwd) : workdir,
      env: envArray(opts?.env),
    });
    const controller = new AbortController();
    if (opts?.signal?.aborted) {
      // Already aborted: the `abort` event has fired, so a listener added now
      // would never run. Propagate immediately.
      controller.abort();
    } else {
      opts?.signal?.addEventListener("abort", () => controller.abort(), {
        once: true,
      });
    }

    const body = await startExecStream(conn, execId, controller.signal);
    const stdout = new StreamQueue();
    const stderr = new StreamQueue();

    // Pump the multiplexed stream into the two queues; completes when the exec
    // stream ends. `wait()` awaits this, then reads the recorded exit code.
    const pump = (async () => {
      try {
        for await (const frame of demuxExecStream(body)) {
          (frame.stream === "stdout" ? stdout : stderr).push(
            decodeChunk(frame.data),
          );
        }
      } finally {
        stdout.close();
        stderr.close();
      }
    })();

    return {
      pid: -1,
      stdout: stdout.iterate(),
      stderr: stderr.iterate(),
      stdin: {
        // Non-hijacked exec has no writable stdin; adapters branch on the
        // `writableStdin: false` capability and never call these. Kept sync
        // (they only wrap a resolved/rejected promise).
        // eslint-disable-next-line promise-function-async
        write: () =>
          Promise.reject(
            new Error(
              "bun-docker: exec stdin is not writable (writableStdin=false)",
            ),
          ),
        // eslint-disable-next-line promise-function-async -- sync no-op; stdin unused when writableStdin=false
        end: () => Promise.resolve(),
      },
      wait: async () => {
        await pump;
        return await inspectExecExitCode(conn, execId).catch(() => 0);
      },
      // eslint-disable-next-line promise-function-async -- sync abort, returns a resolved promise
      kill: () => {
        controller.abort();
        return Promise.resolve();
      },
    };
  };

  const sandboxProcess = { exec, spawn };

  return {
    id: containerId,
    provider: "bun-docker",
    workspaceRoot: workdir,
    capabilities: BUN_DOCKER_CAPS,
    process: sandboxProcess,
    git: createExecBackedGit(sandboxProcess, workdir),
    env: {
      // eslint-disable-next-line promise-function-async -- sync env merge, returns a resolved promise
      set: (vars) => {
        Object.assign(envVars, vars);
        return Promise.resolve();
      },
    },
    ports: {
      connect: () => {
        throw new UnsupportedCapabilityError("ports", "bun-docker");
      },
    },
    fs: {
      read: async (p) => {
        const r = await exec(`base64 ${shellQuote(abs(p))}`);
        if (r.exitCode !== 0) {
          throw new DockerApiError({
            message: `read failed: ${r.stderr.trim()}`,
          });
        }
        return Buffer.from(r.stdout, "base64").toString("utf-8");
      },
      readBytes: async (p) => {
        const r = await exec(`base64 ${shellQuote(abs(p))}`);
        if (r.exitCode !== 0) {
          throw new DockerApiError({
            message: `read failed: ${r.stderr.trim()}`,
          });
        }
        return new Uint8Array(Buffer.from(r.stdout, "base64"));
      },
      write: async (p, data) => {
        const absPath = abs(p);
        const bytes =
          typeof data === "string"
            ? Buffer.from(data, "utf-8")
            : Buffer.from(data);
        // The base64 payload rides as a single argv entry, so a write is
        // bounded by the container's ARG_MAX (~128KB–2MB). That covers the
        // harness's config/prompt files; streaming large binaries via the
        // archive API (PUT /containers/{id}/archive) is a follow-up.
        const b64 = bytes.toString("base64");
        const dir = absPath.replace(/\/[^/]*$/u, "") || "/";
        const r = await exec(
          `mkdir -p ${shellQuote(dir)} && printf %s ${shellQuote(b64)} | base64 -d > ${shellQuote(absPath)}`,
        );
        if (r.exitCode !== 0) {
          throw new DockerApiError({
            message: `write failed: ${r.stderr.trim()}`,
          });
        }
      },
      list: async (p) => {
        const r = await exec(`ls -1Ap ${shellQuote(abs(p))}`);
        if (r.exitCode !== 0) {
          throw new DockerApiError({
            message: `list failed: ${r.stderr.trim()}`,
          });
        }
        return r.stdout
          .split("\n")
          .filter((line) => line.trim() !== "")
          .map((entry) => {
            const isDir = entry.endsWith("/");
            const name = isDir ? entry.slice(0, -1) : entry;
            return {
              name,
              path: `${p.replace(/\/$/u, "")}/${name}`,
              type: isDir ? ("dir" as const) : ("file" as const),
            };
          });
      },
      mkdir: async (p) => {
        await exec(`mkdir -p ${shellQuote(abs(p))}`);
      },
      remove: async (p) => {
        await exec(`rm -rf ${shellQuote(abs(p))}`);
      },
      rename: async (from, to) => {
        await exec(`mv ${shellQuote(abs(from))} ${shellQuote(abs(to))}`);
      },
      exists: async (p) => {
        const r = await exec(`test -e ${shellQuote(abs(p))}`);
        return r.exitCode === 0;
      },
    },
    snapshot: async (label) => {
      snapshotSeq += 1;
      const tag = `${containerId.slice(0, 12)}-${snapshotSeq}`;
      const imageId = await commitContainer(
        conn,
        containerId,
        SNAPSHOT_REPO,
        tag,
      );
      return { id: imageId, ...(label ? { label } : {}) };
    },
    destroy: async () => {
      await stopContainer(conn, containerId);
      if (deps.removeOnDestroy) {
        await removeContainer(conn, containerId);
      }
    },
  };
};

/**
 * Bun-native Docker sandbox provider: a drop-in `SandboxProvider` that speaks
 * the Docker Engine API over a unix socket with bun's `fetch`, avoiding
 * dockerode's connection-hijack path that bun cannot drive. Non-hijacked exec
 * gives streamed output (no stdin) — `writableStdin: false` — which the harness
 * adapters already accommodate.
 */
export const bunDockerSandbox = (
  config: BunDockerSandboxConfig,
): SandboxProvider => {
  const conn: DockerConn = {
    socketPath: config.socketPath ?? "/var/run/docker.sock",
  };
  const workdir = config.workdir ?? DEFAULT_WORKDIR;
  const removeOnDestroy = config.removeOnDestroy ?? true;
  const hostGateway = config.hostGateway ?? true;

  const start = async (opts?: {
    image?: string;
    env?: Record<string, string>;
  }): Promise<SandboxHandle> => {
    const image = opts?.image ?? config.image;
    if (!(await imageExists(conn, image))) {
      await pullImage(conn, image);
    }
    const containerId = await createContainer(conn, {
      image,
      workdir,
      cmd: KEEP_ALIVE_CMD,
      hostGateway,
      ...(config.networkMode ? { networkMode: config.networkMode } : {}),
      ...(opts?.env
        ? { env: Object.entries(opts.env).map(([k, v]) => `${k}=${v}`) }
        : {}),
    });
    await startContainer(conn, containerId);
    const handle = createBunDockerHandle({
      conn,
      containerId,
      workdir,
      removeOnDestroy,
    });
    await handle.fs.mkdir(workdir);
    return handle;
  };

  return {
    name: "bun-docker",
    capabilities: () => BUN_DOCKER_CAPS,
    create: async (input: SandboxCreateInput) =>
      await start(input.env ? { env: input.env } : {}),
    restoreSnapshot: async (input) =>
      await start({
        image: input.snapshotId,
        ...(input.env ? { env: input.env } : {}),
      }),
    resume: async (input: SandboxResumeInput) => {
      const running = await inspectContainerRunning(conn, input.id);
      if (running === null) {
        return null;
      }
      if (!running) {
        await startContainer(conn, input.id);
      }
      return createBunDockerHandle({
        conn,
        containerId: input.id,
        workdir,
        removeOnDestroy,
      });
    },
    destroy: async (input) => {
      await stopContainer(conn, input.id);
      if (removeOnDestroy) {
        await removeContainer(conn, input.id);
      }
    },
  };
};
