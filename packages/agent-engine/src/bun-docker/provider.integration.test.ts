import { describe, expect, test } from "bun:test";

import { bunDockerSandbox } from "./provider";

const RUN_DOCKER_TESTS = process.env["AGENT_ENGINE_DOCKER_TEST"] === "1";
const IMAGE =
  process.env["AGENT_ENGINE_DOCKER_IMAGE"] ?? "stella/agent-sandbox:dev";
const NETWORK_MODE = process.env["AGENT_ENGINE_DOCKER_NETWORK"];

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
      expect(inspected).toMatchObject({ Config: { User: "agent" } });
      if (NETWORK_MODE) {
        expect(inspected).toMatchObject({
          HostConfig: { ExtraHosts: null, NetworkMode: NETWORK_MODE },
        });
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
});
