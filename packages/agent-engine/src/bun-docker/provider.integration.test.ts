import { describe, expect, test } from "bun:test";

import { bunDockerSandbox } from "./provider";

const RUN_DOCKER_TESTS = process.env["AGENT_ENGINE_DOCKER_TEST"] === "1";
const IMAGE =
  process.env["AGENT_ENGINE_DOCKER_IMAGE"] ?? "stella/agent-sandbox:dev";
const NETWORK_MODE = process.env["AGENT_ENGINE_DOCKER_NETWORK"];
const NETWORK_CANARY_URL = process.env["AGENT_ENGINE_DOCKER_CANARY_URL"] ?? "";

const provider = bunDockerSandbox({
  image: IMAGE,
  ...(NETWORK_MODE ? { networkMode: NETWORK_MODE } : {}),
});

const collect = async (source: AsyncIterable<string>): Promise<string> => {
  let value = "";
  for await (const chunk of source) {
    value += chunk;
  }
  return value;
};

const inspectContainer = async (containerId: string) => {
  const process = Bun.spawn(["docker", "inspect", containerId], {
    stderr: "pipe",
    stdout: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(`docker inspect failed: ${stderr.trim()}`);
  }
  const parsed: unknown = JSON.parse(stdout);
  if (!Array.isArray(parsed) || parsed.length !== 1) {
    throw new Error("docker inspect returned an unexpected response");
  }
  return parsed.at(0);
};

const listImageContainers = async (): Promise<string[]> => {
  const process = Bun.spawn(
    ["docker", "ps", "--all", "--quiet", "--filter", `ancestor=${IMAGE}`],
    {
      stderr: "pipe",
      stdout: "pipe",
    },
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(`docker ps failed: ${stderr.trim()}`);
  }
  return stdout
    .split("\n")
    .filter((containerId) => containerId !== "")
    .sort();
};

const rejectionState = async (
  operation: Promise<unknown>,
): Promise<"rejected" | "resolved"> =>
  await operation.then(
    () => "resolved" as const,
    () => "rejected" as const,
  );

describe.skipIf(!RUN_DOCKER_TESTS)("bun Docker provider integration", () => {
  test("executes, streams, round-trips files, and removes the sandbox", async () => {
    const handle = await provider.create({
      env: { PROVIDER_SMOKE_MARKER: "present" },
    });

    try {
      const direct = await handle.process.exec(
        'test "$PROVIDER_SMOKE_MARKER" = present && printf žluťoučký && printf warning >&2',
      );
      expect(direct).toEqual({
        exitCode: 0,
        stderr: "warning",
        stdout: "žluťoučký",
      });

      await handle.fs.write("/workspace/probe.txt", "Příliš žluťoučký kůň");
      expect(await handle.fs.read("/workspace/probe.txt")).toBe(
        "Příliš žluťoučký kůň",
      );

      const spawned = await handle.process.spawn(
        "printf stream-ready; printf stream-warning >&2",
      );
      const [stdout, stderr, exitCode] = await Promise.all([
        collect(spawned.stdout),
        collect(spawned.stderr),
        spawned.wait(),
      ]);
      expect({ exitCode, stderr, stdout }).toEqual({
        exitCode: 0,
        stderr: "stream-warning",
        stdout: "stream-ready",
      });

      const inspected = await inspectContainer(handle.id);
      expect(inspected).toMatchObject({
        Config: { User: "agent" },
        HostConfig: {
          Binds: null,
          CapDrop: ["ALL"],
          SecurityOpt: ["no-new-privileges"],
        },
        Mounts: [],
      });
      if (NETWORK_MODE) {
        expect(inspected).toMatchObject({
          HostConfig: { ExtraHosts: null, NetworkMode: NETWORK_MODE },
        });
      }

      const socketProbe = await handle.process.exec(
        "test ! -S /var/run/docker.sock",
      );
      expect(socketProbe.exitCode).toBe(0);

      if (NETWORK_CANARY_URL) {
        const canaryProbe = await handle.process.exec(
          `node -e 'fetch(process.env.NETWORK_CANARY_URL, { signal: AbortSignal.timeout(3000) }).then(async (response) => { if (!response.ok || (await response.text()) !== "sandbox-network-canary") process.exit(1) })'`,
          { env: { NETWORK_CANARY_URL } },
        );
        expect(canaryProbe).toMatchObject({ exitCode: 0 });

        const internetProbe = await handle.process.exec(
          "node -e 'fetch(\"https://example.com\", { signal: AbortSignal.timeout(1500) }).then(() => process.exit(1), () => process.exit(0))'",
        );
        expect(internetProbe.exitCode).toBe(0);

        const directInternetProbe = await handle.process.exec(
          'node -e \'const socket = require("node:net").createConnection({ host: "1.1.1.1", port: 443 }); socket.setTimeout(1500); socket.on("connect", () => process.exit(1)); socket.on("error", () => process.exit(0)); socket.on("timeout", () => process.exit(0))\'',
        );
        expect(directInternetProbe.exitCode).toBe(0);

        const hostAliasProbe = await handle.process.exec(
          'node -e \'require("node:dns").promises.lookup("host.docker.internal").then(() => process.exit(1), () => process.exit(0))\'',
        );
        expect(hostAliasProbe.exitCode).toBe(0);
      }
    } finally {
      await handle.destroy();
    }

    expect(await provider.resume({ id: handle.id })).toBeNull();
  });

  test("kill terminates the sandbox even when wait is not observed", async () => {
    const handle = await provider.create({});
    const spawned = await handle.process.spawn("sleep 300");

    await spawned.kill();

    expect(await provider.resume({ id: handle.id })).toBeNull();
    // Lifecycle cleanup is deliberately idempotent after process cancellation.
    await handle.destroy();
  });

  test("an external abort removes the sandbox and its running process", async () => {
    const handle = await provider.create({});
    const controller = new AbortController();
    const spawned = await handle.process.spawn("sleep 300", {
      signal: controller.signal,
    });

    controller.abort();

    expect(await rejectionState(spawned.wait())).toBe("rejected");
    expect(await provider.resume({ id: handle.id })).toBeNull();
  });

  test("a process timeout removes the sandbox even before spawn returns", async () => {
    const handle = await provider.create({});
    const runUntilTimeout = async (): Promise<void> => {
      const spawned = await handle.process.spawn("sleep 300", {
        signal: AbortSignal.timeout(100),
      });
      await spawned.wait();
    };

    expect(await rejectionState(runUntilTimeout())).toBe("rejected");
    expect(await provider.resume({ id: handle.id })).toBeNull();
  });

  test("a failed container start leaves no partial sandbox behind", async () => {
    const containersBefore = await listImageContainers();
    const failingProvider = bunDockerSandbox({
      image: IMAGE,
      workdir: "/proc/stella-agent-invalid",
      ...(NETWORK_MODE ? { networkMode: NETWORK_MODE } : {}),
    });

    expect(await rejectionState(failingProvider.create({}))).toBe("rejected");

    expect(await listImageContainers()).toEqual(containersBefore);
  });

  test("concurrent sandboxes stay isolated and clean up independently", async () => {
    const handles = await Promise.all([
      provider.create({ env: { ISOLATION_MARKER: "first" } }),
      provider.create({ env: { ISOLATION_MARKER: "second" } }),
    ]);

    try {
      const results = await Promise.all(
        handles.map(async (handle) => {
          await handle.fs.write(
            "/workspace/isolation.txt",
            (await handle.process.exec('printf %s "$ISOLATION_MARKER"')).stdout,
          );
          return await handle.fs.read("/workspace/isolation.txt");
        }),
      );
      expect(results).toEqual(["first", "second"]);
    } finally {
      await Promise.all(handles.map(async (handle) => await handle.destroy()));
    }

    expect(
      await Promise.all(
        handles.map(async (handle) => await provider.resume({ id: handle.id })),
      ),
    ).toEqual([null, null]);
  });
});
