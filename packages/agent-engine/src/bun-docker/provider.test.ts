import { afterEach, describe, expect, mock, test } from "bun:test";

import { DockerApiError } from "./api";
import { bunDockerSandbox } from "./provider";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  mock.restore();
});

const dockerFrame = (stream: "stdout" | "stderr", text: string): Uint8Array => {
  const payload = new TextEncoder().encode(text);
  const frame = new Uint8Array(8 + payload.length);
  frame[0] = stream === "stderr" ? 2 : 1;
  new DataView(frame.buffer).setUint32(4, payload.length, false);
  frame.set(payload, 8);
  return frame;
};

type ExecFixture = {
  exitCode: number;
  stderr: string;
  streamFailure: boolean;
};

const execFixture = (command: string): ExecFixture => {
  if (command.includes("denied-mkdir")) {
    return { exitCode: 7, stderr: "mkdir denied", streamFailure: false };
  }
  if (command.includes("protected-remove")) {
    return { exitCode: 8, stderr: "remove denied", streamFailure: false };
  }
  if (command.includes("missing-source")) {
    return { exitCode: 9, stderr: "rename denied", streamFailure: false };
  }
  if (command === "explode-stream") {
    return { exitCode: 137, stderr: "", streamFailure: true };
  }
  return { exitCode: 0, stderr: "", streamFailure: false };
};

const requestCommand = (body: RequestInit["body"]): string => {
  if (typeof body !== "string") {
    throw new DockerApiError({ message: "test Docker request body missing" });
  }
  const parsed: unknown = JSON.parse(body);
  if (typeof parsed !== "object" || parsed === null || !("Cmd" in parsed)) {
    throw new DockerApiError({ message: "test Docker exec command missing" });
  }
  const cmd = parsed.Cmd;
  const command = Array.isArray(cmd) ? cmd.at(2) : undefined;
  if (typeof command !== "string") {
    throw new DockerApiError({ message: "test Docker shell command missing" });
  }
  return command;
};

const streamFor = (fixture: ExecFixture): ReadableStream<Uint8Array> =>
  new ReadableStream({
    start(controller) {
      if (fixture.streamFailure) {
        controller.error(new DOMException("stream timed out", "TimeoutError"));
        return;
      }
      if (fixture.stderr !== "") {
        controller.enqueue(dockerFrame("stderr", fixture.stderr));
      }
      controller.close();
    },
  });

type DockerFake = {
  cleanup: Promise<void>;
  removals: string[];
};

const installDockerFake = (): DockerFake => {
  const execs = new Map<string, ExecFixture>();
  const removals: string[] = [];
  let nextExecId = 0;
  let resolveCleanup: (() => void) | undefined;
  const cleanup = new Promise<void>((resolve) => {
    resolveCleanup = resolve;
  });

  globalThis.fetch = Object.assign(
    mock(async (input, init) => {
      const url = new URL(String(input));
      const method = init?.method ?? "GET";

      if (method === "GET" && url.pathname.startsWith("/images/")) {
        return new Response("{}");
      }
      if (method === "POST" && url.pathname === "/containers/create") {
        return Response.json({ Id: "container-1" }, { status: 201 });
      }
      if (
        method === "POST" &&
        url.pathname === "/containers/container-1/start"
      ) {
        return new Response(null, { status: 204 });
      }
      if (
        method === "POST" &&
        url.pathname === "/containers/container-1/exec"
      ) {
        const execId = `exec-${nextExecId}`;
        nextExecId += 1;
        execs.set(execId, execFixture(requestCommand(init?.body)));
        return Response.json({ Id: execId }, { status: 201 });
      }
      const execStart = /^\/exec\/(exec-\d+)\/start$/u.exec(url.pathname);
      if (method === "POST" && execStart) {
        const fixture = execs.get(execStart.at(1) ?? "");
        if (!fixture) {
          return new Response("missing exec", { status: 404 });
        }
        return new Response(streamFor(fixture));
      }
      const execInspect = /^\/exec\/(exec-\d+)\/json$/u.exec(url.pathname);
      if (method === "GET" && execInspect) {
        const fixture = execs.get(execInspect.at(1) ?? "");
        return fixture
          ? Response.json({ ExitCode: fixture.exitCode })
          : new Response("missing exec", { status: 404 });
      }
      if (method === "DELETE" && url.pathname === "/containers/container-1") {
        removals.push(url.pathname);
        resolveCleanup?.();
        return new Response(null, { status: 204 });
      }
      return new Response("unexpected request", { status: 500 });
    }),
    { preconnect: originalFetch.preconnect.bind(originalFetch) },
  );

  return { cleanup, removals };
};

describe("bun Docker provider failure handling", () => {
  test("advertises spawned processes as killable", async () => {
    installDockerFake();
    const provider = bunDockerSandbox({ image: "sandbox:test" });
    const handle = await provider.create({});

    expect(handle.capabilities.killableProcesses).toBe(true);
    await handle.destroy();
  });

  test("filesystem mutations surface nonzero command exit codes", async () => {
    const { removals } = installDockerFake();
    const provider = bunDockerSandbox({ image: "sandbox:test" });
    const handle = await provider.create({});

    expect(handle.fs.mkdir("/denied-mkdir")).rejects.toBeInstanceOf(
      DockerApiError,
    );
    expect(handle.fs.remove("/protected-remove")).rejects.toBeInstanceOf(
      DockerApiError,
    );
    expect(
      handle.fs.rename("/missing-source", "/workspace/target"),
    ).rejects.toBeInstanceOf(DockerApiError);

    await handle.destroy();
    expect(removals).toEqual(["/containers/container-1"]);
  });

  test("an abnormal exec stream removes the container without wait being observed", async () => {
    const { cleanup, removals } = installDockerFake();
    const provider = bunDockerSandbox({ image: "sandbox:test" });
    const handle = await provider.create({});

    await handle.process.spawn("explode-stream");
    await cleanup;

    expect(removals).toEqual(["/containers/container-1"]);
  });
});
