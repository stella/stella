import { describe, expect, test } from "bun:test";

import { rejectionOf } from "@stll/property-testing/rejection";

import { resolveDockerTarget } from "./dev-docker";
import { dockerKeeperCommand, ensureDockerKeeper } from "./dev-docker-keeper";

describe("protected Docker runtime recovery", () => {
  test("a missing runtime is recovered by its keeper without starting Colima", async () => {
    const calls: string[][] = [];
    let started = false;
    await ensureDockerKeeper({
      dockerTarget: resolveDockerTarget({
        env: {},
        inspect: () => "unix:///tmp/test-docker.sock",
      }),
      label: "dev.test.docker-keeper",
      run: (command) => {
        calls.push(command);
        if (command.at(0) === "launchctl") {
          started = true;
          return true;
        }
        return started;
      },
      now: () => 0,
      sleep: async () => {},
    });
    expect(calls).toEqual([
      ["docker", "--host", "unix:///tmp/test-docker.sock", "info"],
      ["launchctl", "kickstart", "system/dev.test.docker-keeper"],
      ["docker", "--host", "unix:///tmp/test-docker.sock", "info"],
    ]);
    expect(calls.some((command) => command.includes("colima"))).toBe(false);
  });

  test("a healthy runtime never touches its keeper", async () => {
    const calls: string[][] = [];
    await ensureDockerKeeper({
      dockerTarget: resolveDockerTarget({
        env: {},
        inspect: () => "unix:///tmp/test-docker.sock",
      }),
      label: "dev.test.docker-keeper",
      run: (command) => {
        calls.push(command);
        return true;
      },
      now: () => 0,
      sleep: async () => {},
    });
    expect(calls).toEqual([
      ["docker", "--host", "unix:///tmp/test-docker.sock", "info"],
    ]);
  });

  test("recovery has a deadline even when the keeper accepts its kickstart", async () => {
    let elapsed = 0;
    expect(
      await rejectionOf(
        ensureDockerKeeper({
          dockerTarget: resolveDockerTarget({
            env: {},
            inspect: () => "unix:///tmp/test-docker.sock",
          }),
          label: "dev.test.docker-keeper",
          run: (command) => command.at(0) === "launchctl",
          now: () => elapsed,
          sleep: (milliseconds) => {
            elapsed += milliseconds;
            return Promise.resolve();
          },
        }),
      ),
    ).toMatchObject({
      message: expect.stringContaining(
        "did not recover Docker within 120 seconds",
      ),
    });
    expect(elapsed).toBe(120_000);
  });
});

test("system keeper requests use stable cwd and noninteractive privilege", () => {
  expect(
    dockerKeeperCommand({
      command: ["launchctl", "kickstart", "system/dev.test.docker-keeper"],
      platform: "darwin",
      uid: 501,
    }),
  ).toEqual({
    command: [
      "sudo",
      "-n",
      "--",
      "launchctl",
      "kickstart",
      "system/dev.test.docker-keeper",
    ],
    cwd: "/",
  });
  expect(
    dockerKeeperCommand({
      command: ["docker", "--host", "unix:///tmp/test-docker.sock", "info"],
      platform: "darwin",
      uid: 501,
    }),
  ).toEqual({
    command: ["docker", "--host", "unix:///tmp/test-docker.sock", "info"],
    cwd: "/",
  });
});

test("invalid keeper labels are refused before executing a command", async () => {
  let ran = false;
  expect(
    await rejectionOf(
      ensureDockerKeeper({
        dockerTarget: resolveDockerTarget({
          env: {},
          inspect: () => "unix:///tmp/test-docker.sock",
        }),
        label: "../other-keeper",
        run: () => {
          ran = true;
          return true;
        },
        now: () => 0,
        sleep: async () => {},
      }),
    ),
  ).toMatchObject({
    message: expect.stringContaining("Invalid Docker keeper label"),
  });
  expect(ran).toBe(false);
});

test("a refused keeper kickstart surfaces the failure", async () => {
  expect(
    await rejectionOf(
      ensureDockerKeeper({
        dockerTarget: resolveDockerTarget({
          env: {},
          inspect: () => "unix:///tmp/test-docker.sock",
        }),
        label: "dev.test.docker-keeper",
        run: () => false,
        now: () => 0,
        sleep: async () => {},
      }),
    ),
  ).toMatchObject({
    message: expect.stringContaining(
      "Cannot start Docker keeper dev.test.docker-keeper",
    ),
  });
});
