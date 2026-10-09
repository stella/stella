import { Result } from "better-result";
import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  AUTO_INFRA_OFFSET_GRID,
  buildPersistentSteps,
  buildPreparationSteps,
  checkPortAvailabilityOnHosts,
  createApiEnv,
  createDesktopEnv,
  createWebEnv,
  describeFailedProbes,
  dockerComposeDownCommand,
  dockerProjectBelongsToWorktree,
  dockerProjectName,
  ensureWorktreeEnvLinks,
  expandEnvMap,
  findFirstAvailableOffset,
  getSharedDockerServicesWaitFailure,
  hasConflictingDockerOwner,
  hasLegacyObjectStoreService,
  infraPortsForOffset,
  isWorktreeCheckout,
  loadEnvFile,
  MAX_HASH_OFFSET,
  migrateLegacyS3DevCredentials,
  projectsForDeletedWorktrees,
  parseDockerComposePsJson,
  parseForeignPortOwners,
  parseStellaDockerProject,
  portsForOffset,
  requiredPortsForMode,
  resolveAutoInfraOffset,
  resolveMainRootFromCommonDir,
  reportGroupStopFailure,
  resolveOffset,
  runMainAndExit,
  shouldAutoOpenBrowser,
} from "./dev-runner";
import {
  DEFAULT_INFRA_PORTS,
  DEFAULT_PORTS,
  MAX_INFRA_OFFSET,
  MAX_PORT_OFFSET,
  parseDevRunnerConfig,
} from "./dev-runner-config";
import {
  devStatePath,
  readOrCreateDevContentEncryptionKey,
} from "./dev-runtime";
import { formatErrorChain } from "./error-chain";

const tempDirs: string[] = [];

const createTempDir = () => {
  const dir = mkdtempSync(path.resolve(tmpdir(), "stella-dev-runner-"));
  tempDirs.push(dir);
  return dir;
};

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

describe("parseDevRunnerConfig", () => {
  test("uses dev mode and an automatic infrastructure offset by default", () => {
    expect(parseDevRunnerConfig({ args: [], environment: {} })).toMatchObject({
      status: "ok",
      value: {
        infraOffset: { type: "auto" },
        mode: "dev",
        seed: false,
      },
    });
  });

  test("accepts auto from the flag and the environment", () => {
    for (const input of [
      { args: ["--infra-offset", "auto"], environment: {} },
      { args: [], environment: { STELLA_INFRA_OFFSET: "auto" } },
    ]) {
      expect(parseDevRunnerConfig(input)).toMatchObject({
        status: "ok",
        value: { infraOffset: { type: "auto" } },
      });
    }
  });

  test("gives CLI offsets and instance precedence over environment values", () => {
    expect(
      parseDevRunnerConfig({
        args: [
          "--port-offset",
          "8",
          "--infra-offset",
          "10",
          "--dev-instance",
          "cli-instance",
        ],
        environment: {
          STELLA_DEV_INSTANCE: "environment-instance",
          STELLA_INFRA_OFFSET: "12",
          STELLA_PORT_OFFSET: "14",
        },
      }),
    ).toMatchObject({
      status: "ok",
      value: {
        devInstance: "cli-instance",
        infraOffset: { offset: 10, type: "fixed" },
        portOffset: 8,
      },
    });
  });

  test("parses mode and control flags at the same boundary", () => {
    expect(
      parseDevRunnerConfig({
        args: [
          "dev:desktop",
          "--skip-install",
          "--skip-db-push",
          "--dry-run",
          "--no-browser",
          "--seed",
        ],
        environment: {},
      }),
    ).toMatchObject({
      status: "ok",
      value: {
        dryRun: true,
        mode: "dev:desktop",
        noBrowser: true,
        seed: true,
        skipDbPush: true,
        skipInstall: true,
      },
    });
  });

  test.each(["8oops", "1.5", "1e2", "9007199254740992"])(
    "rejects malformed or unsafe values from both offset environment variables: %s",
    (value) => {
      for (const variable of ["STELLA_PORT_OFFSET", "STELLA_INFRA_OFFSET"]) {
        const result = parseDevRunnerConfig({
          args: [],
          environment: { [variable]: value },
        });

        expect(result.status).toBe("error");
        if (result.status === "error") {
          expect(result.error.code).toBe("invalid-integer");
          expect(result.error.source).toBe(variable);
        }
      }
    },
  );

  test.each(["8oops", "1.5", "1e2", "9007199254740992"])(
    "rejects malformed or unsafe values from both offset CLI flags: %s",
    (value) => {
      for (const flag of ["--port-offset", "--infra-offset"]) {
        const result = parseDevRunnerConfig({
          args: [flag, value],
          environment: {},
        });

        expect(result.status).toBe("error");
        if (result.status === "error") {
          expect(result.error.code).toBe("invalid-integer");
          expect(result.error.source).toBe(flag);
        }
      }
    },
  );

  test("rejects an unsafe numeric dev instance before side effects", () => {
    const result = parseDevRunnerConfig({
      args: [],
      environment: { STELLA_DEV_INSTANCE: "9007199254740992" },
    });

    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error.code).toBe("invalid-integer");
      expect(result.error.source).toBe("numeric STELLA_DEV_INSTANCE");
    }
  });

  test.each([
    ["STELLA_PORT_OFFSET", "--port-offset", MAX_PORT_OFFSET],
    ["STELLA_INFRA_OFFSET", "--infra-offset", MAX_INFRA_OFFSET],
  ] as const)(
    "rejects values above the %s maximum from both sources",
    (environmentName, flag, maximum) => {
      const value = String(maximum + 1);
      for (const input of [
        { args: [], environment: { [environmentName]: value } },
        { args: [flag, value], environment: {} },
      ]) {
        const result = parseDevRunnerConfig(input);

        expect(result.status).toBe("error");
        if (result.status === "error") {
          expect(result.error.code).toBe("out-of-range");
          expect(result.error.source).toBe(
            input.args.length === 0 ? environmentName : flag,
          );
        }
      }
    },
  );
});

describe("resolveOffset", () => {
  const worktreePath = "/Users/dev/stella/.worktrees/dev-runner";

  test("uses explicit port offset when provided", () => {
    expect(
      resolveOffset({
        devInstance: undefined,
        isWorktree: true,
        portOffset: 12,
        worktreePath,
      }),
    ).toEqual({
      offset: 12,
      source: "STELLA_PORT_OFFSET=12",
    });
  });

  test("rejects explicit offsets above the maximum valid port range", () => {
    expect(() =>
      resolveOffset({
        devInstance: undefined,
        isWorktree: true,
        portOffset: 19_635,
        worktreePath,
      }),
    ).toThrow("STELLA_PORT_OFFSET must be an integer between 0 and 19634");
  });

  test("rejects numeric dev instances above the maximum valid port range", () => {
    expect(() =>
      resolveOffset({
        devInstance: "19635",
        isWorktree: true,
        portOffset: undefined,
        worktreePath,
      }),
    ).toThrow(
      "numeric STELLA_DEV_INSTANCE must be an integer between 0 and 19634",
    );
  });

  test("uses default ports for the main checkout", () => {
    expect(
      resolveOffset({
        devInstance: undefined,
        isWorktree: false,
        portOffset: undefined,
        worktreePath: "/Users/dev/stella",
      }),
    ).toEqual({
      offset: 0,
      source: "default ports",
    });
  });

  test("hashes the worktree path into the bucket range", () => {
    const resolved = resolveOffset({
      devInstance: undefined,
      isWorktree: true,
      portOffset: undefined,
      worktreePath,
    });

    expect(resolved.offset).toBeGreaterThan(0);
    expect(resolved.offset).toBeLessThanOrEqual(MAX_HASH_OFFSET);
    expect(resolved.source).toBe(`hashed worktree path=${worktreePath}`);
  });

  test("gives sibling worktrees separate offsets", () => {
    const offsetFor = (candidatePath: string) =>
      resolveOffset({
        devInstance: undefined,
        isWorktree: true,
        portOffset: undefined,
        worktreePath: candidatePath,
      }).offset;

    expect(offsetFor("/Users/dev/stella/.worktrees/alpha")).not.toBe(
      offsetFor("/Users/dev/stella/.worktrees/beta"),
    );
  });
});

describe("automatic infrastructure offsets", () => {
  const worktreePath = "/Users/dev/stella/.worktrees/alpha";
  const allFree = async () => true;
  const infraPortSet = (offset: number) =>
    Object.values(infraPortsForOffset(offset));
  const gridStep = (offset: number, steps: number) => {
    const { base, slots, stride } = AUTO_INFRA_OFFSET_GRID;
    return base + (((offset - base) / stride + steps) % slots) * stride;
  };

  test("no two grid offsets publish the same host port", () => {
    const defaults = Object.values(DEFAULT_INFRA_PORTS);
    for (const left of defaults) {
      for (const right of defaults) {
        if (left !== right) {
          expect(
            Math.abs(left - right) % AUTO_INFRA_OFFSET_GRID.stride,
          ).not.toBe(0);
        }
      }
    }
  });

  test("the grid stays clear of application ports and the ephemeral range", () => {
    const { base, slots, stride } = AUTO_INFRA_OFFSET_GRID;
    const lowest = Math.min(...infraPortSet(base));
    const highest = Math.max(...infraPortSet(base + (slots - 1) * stride));
    const applicationPorts = Object.values(DEFAULT_PORTS).flatMap((port) => [
      port,
      port + MAX_HASH_OFFSET,
    ]);
    const EPHEMERAL_PORT_START = 49_152;

    expect(highest).toBeLessThan(EPHEMERAL_PORT_START);
    for (const port of applicationPorts) {
      expect(port < lowest || port > highest).toBe(true);
    }
  });

  test("reuses the offset of this worktree's existing project", async () => {
    const own = dockerProjectName({
      infraOffset: 12_340,
      isWorktree: true,
      worktreePath,
    });

    expect(
      await resolveAutoInfraOffset({
        isPortFree: async () => false,
        knownProjects: ["stella-dev", own, "unrelated"],
        reservedPorts: [],
        worktreePath,
      }),
    ).toEqual({ offset: 12_340, source: "this worktree's Docker project" });
  });

  test("is stable for a worktree and lands on the grid", async () => {
    const resolve = async () =>
      await resolveAutoInfraOffset({
        isPortFree: allFree,
        knownProjects: [],
        reservedPorts: [],
        worktreePath,
      });
    const first = await resolve();

    expect(await resolve()).toEqual(first);
    expect(
      (first.offset - AUTO_INFRA_OFFSET_GRID.base) %
        AUTO_INFRA_OFFSET_GRID.stride,
    ).toBe(0);
  });

  test("skips offsets whose ports another project or a busy host port holds", async () => {
    const hashed = await resolveAutoInfraOffset({
      isPortFree: allFree,
      knownProjects: [],
      reservedPorts: [],
      worktreePath,
    });
    const taken = dockerProjectName({
      infraOffset: hashed.offset,
      isWorktree: true,
      worktreePath: "/Users/dev/stella/.worktrees/beta",
    });
    const busyPort = infraPortsForOffset(gridStep(hashed.offset, 1)).postgres;

    const resolved = await resolveAutoInfraOffset({
      isPortFree: async (port) => port !== busyPort,
      knownProjects: [taken],
      reservedPorts: [],
      worktreePath,
    });

    expect(resolved.offset).toBe(gridStep(hashed.offset, 2));
    expect(resolved.source).toContain("adjusted");
  });

  test("parses the offset and worktree hash out of project names", () => {
    expect(parseStellaDockerProject("stella-dev")).toEqual({
      offset: 0,
      worktreeHash: undefined,
    });
    expect(parseStellaDockerProject("stella-dev-120")).toEqual({
      offset: 120,
      worktreeHash: undefined,
    });
    expect(parseStellaDockerProject("stella-dev-44000-0123456789ab")).toEqual({
      offset: 44_000,
      worktreeHash: "0123456789ab",
    });
    expect(parseStellaDockerProject("kodecar")).toBeUndefined();
  });
});

describe("Docker project ownership", () => {
  const alpha = "/Users/dev/stella/.worktrees/alpha";
  const beta = "/Users/dev/stella/.worktrees/beta";

  test("keeps the main checkout's existing project names", () => {
    expect(
      dockerProjectName({
        infraOffset: 0,
        isWorktree: false,
        worktreePath: "/Users/dev/stella",
      }),
    ).toBe("stella-dev");
    expect(
      dockerProjectName({
        infraOffset: 120,
        isWorktree: false,
        worktreePath: "/Users/dev/stella",
      }),
    ).toBe("stella-dev-120");
  });

  test("separates worktrees when offsets collide", () => {
    const projectFor = (worktreePath: string) =>
      dockerProjectName({
        infraOffset: 44_000,
        isWorktree: true,
        worktreePath,
      });

    expect(projectFor(alpha)).not.toBe(projectFor(beta));
    expect(projectFor(alpha)).toMatch(/^stella-dev-44000-[a-f0-9]{12}$/u);
  });

  test("builds cleanup against the durable main compose file without deleting volumes", () => {
    const command = dockerComposeDownCommand({
      composeFile: "/Users/dev/stella/docker-compose.yml",
      dockerProject: "stella-dev-44000-cafef00dbeef",
    });

    expect(command).toContain("/Users/dev/stella/docker-compose.yml");
    expect(command).toContain("stella-dev-44000-cafef00dbeef");
    expect(command.slice(-2)).toEqual(["down", "--remove-orphans"]);
    expect(command).not.toContain("--volumes");
  });
});

describe("portsForOffset", () => {
  test("keeps the API, web, and desktop ports in sync", () => {
    expect(portsForOffset(0)).toEqual({
      api: 3001,
      desktopBridge: 45_901,
      desktopView: 5177,
      web: 3000,
    });
    expect(portsForOffset(24)).toEqual({
      api: 3025,
      desktopBridge: 45_925,
      desktopView: 5201,
      web: 3024,
    });
  });
});

describe("infraPortsForOffset", () => {
  test("returns default ports at offset 0", () => {
    expect(infraPortsForOffset(0)).toEqual({
      gotenberg: 3003,
      postgres: 5432,
      rustfs: 9000,
      rustfsConsole: 9001,
      valkey: 6379,
    });
  });

  test("shifts all infra ports by the offset", () => {
    expect(infraPortsForOffset(10)).toEqual({
      gotenberg: 3013,
      postgres: 5442,
      rustfs: 9010,
      rustfsConsole: 9011,
      valkey: 6389,
    });
  });
});

describe("shared Docker service readiness", () => {
  const readyStatuses = [
    {
      exitCode: undefined,
      health: "healthy",
      service: "postgres",
      state: "running",
    },
    {
      exitCode: undefined,
      health: "healthy",
      service: "valkey",
      state: "running",
    },
    {
      exitCode: undefined,
      health: "healthy",
      service: "rustfs",
      state: "running",
    },
    {
      exitCode: undefined,
      health: "healthy",
      service: "gotenberg",
      state: "running",
    },
    {
      exitCode: 0,
      health: undefined,
      service: "rustfs-setup",
      state: "exited",
    },
  ];

  test("parses compose ps JSON arrays", () => {
    expect(
      parseDockerComposePsJson(
        JSON.stringify([
          {
            ExitCode: 0,
            Health: "",
            Service: "rustfs-setup",
            State: "exited",
          },
        ]),
      ),
    ).toEqual([
      {
        exitCode: 0,
        health: "",
        service: "rustfs-setup",
        state: "exited",
      },
    ]);
  });

  test("parses compose ps newline-delimited JSON", () => {
    expect(
      parseDockerComposePsJson(
        [
          JSON.stringify({
            Health: "healthy",
            Service: "postgres",
            State: "running",
          }),
          JSON.stringify({
            ExitCode: "0",
            Service: "rustfs-setup",
            State: "exited",
          }),
        ].join("\n"),
      ),
    ).toEqual([
      {
        exitCode: undefined,
        health: "healthy",
        service: "postgres",
        state: "running",
      },
      {
        exitCode: 0,
        health: undefined,
        service: "rustfs-setup",
        state: "exited",
      },
    ]);
  });

  test("requires health-check readiness for long-running services", () => {
    expect(
      getSharedDockerServicesWaitFailure([
        {
          exitCode: undefined,
          health: "starting",
          service: "postgres",
          state: "running",
        },
      ]),
    ).toBe("postgres is health=starting");
  });

  test("requires the RustFS setup init container to finish successfully", () => {
    expect(
      getSharedDockerServicesWaitFailure([
        ...readyStatuses.slice(0, -1),
        {
          exitCode: undefined,
          health: undefined,
          service: "rustfs-setup",
          state: "running",
        },
      ]),
    ).toBe("rustfs-setup has not completed yet (state=running)");

    expect(getSharedDockerServicesWaitFailure(readyStatuses)).toBeUndefined();
  });
});

describe("describeFailedProbes", () => {
  test("names each failing service with its error", () => {
    expect(
      describeFailedProbes([
        { service: "postgres", status: "ok" },
        {
          error: "connect ECONNRESET 127.0.0.1:27379",
          service: "valkey",
          status: "failed",
        },
        { error: "timeout", service: "rustfs", status: "failed" },
        { error: "HTTP 503", service: "gotenberg", status: "failed" },
      ]),
    ).toEqual([
      "valkey: connect ECONNRESET 127.0.0.1:27379",
      "rustfs: timeout",
      "gotenberg: HTTP 503",
    ]);
  });

  test("reports nothing when every probe succeeded", () => {
    expect(
      describeFailedProbes([
        { service: "postgres", status: "ok" },
        { service: "valkey", status: "ok" },
      ]),
    ).toEqual([]);
  });
});

describe("deleted worktree project discovery", () => {
  const output = [
    "stella-dev-1000\t/worktrees/deleted-a",
    "stella-dev-1000\t/worktrees/deleted-a",
    "stella-dev-2000-aaaaaaaaaaaa\t/worktrees/live-b",
    "stella-dev-3000-bbbbbbbbbbbb\t/worktrees/deleted-c",
    "stella-dev-3000-bbbbbbbbbbbb\t/worktrees/live-c",
    "stella-dev-4000-cccccccccccc\t/worktrees/deleted-d",
    "stella-dev-4000-cccccccccccc\t",
    "stella-dev-preview\t/worktrees/deleted-preview",
    "stella-device-preview\t/worktrees/deleted-device",
    "unrelated-project\t/worktrees/deleted-unrelated",
  ].join("\n");

  test("removes only projects whose every recorded worktree is gone", () => {
    const existing = new Set(["/worktrees/live-b", "/worktrees/live-c"]);

    expect(
      projectsForDeletedWorktrees({
        output,
        pathExists: (candidate) => existing.has(candidate),
      }),
    ).toEqual(["stella-dev-1000"]);
  });

  test("does not infer ownership when Compose recorded no worktree", () => {
    expect(
      projectsForDeletedWorktrees({
        output: "stella-dev-legacy\t",
        pathExists: () => false,
      }),
    ).toEqual([]);
  });

  test("identifies an exclusively owned legacy project", () => {
    const legacyProject = "stella-dev-44000";
    const canonicalPath = "/private/worktrees/current";
    const invokedPath = "/worktrees/current";

    expect(
      dockerProjectBelongsToWorktree({
        dockerProject: legacyProject,
        output: `${legacyProject}\t${invokedPath}`,
        worktreePaths: [canonicalPath, invokedPath],
      }),
    ).toBe(true);
    expect(
      dockerProjectBelongsToWorktree({
        dockerProject: legacyProject,
        output: [
          `${legacyProject}\t${invokedPath}`,
          `${legacyProject}\t/worktrees/other`,
        ].join("\n"),
        worktreePaths: [canonicalPath, invokedPath],
      }),
    ).toBe(false);
    expect(
      dockerProjectBelongsToWorktree({
        dockerProject: legacyProject,
        output: [`${legacyProject}\t${invokedPath}`, `${legacyProject}\t`].join(
          "\n",
        ),
        worktreePaths: [canonicalPath, invokedPath],
      }),
    ).toBe(false);
  });

  test("rejects a second Docker owner in the same worktree", () => {
    const dockerProject = "stella-dev-44000-aaaaaaaaaaaa";
    const projectOutput = `${dockerProject}\t/worktrees/current`;

    expect(
      hasConflictingDockerOwner({
        dockerProject,
        initialOffset: 100,
        output: projectOutput,
        resolvedOffset: 101,
      }),
    ).toBe(true);
    expect(
      hasConflictingDockerOwner({
        dockerProject,
        initialOffset: 100,
        output: projectOutput,
        resolvedOffset: 100,
      }),
    ).toBe(false);
    expect(
      hasConflictingDockerOwner({
        dockerProject: "stella-dev-44000-bbbbbbbbbbbb",
        initialOffset: 100,
        output: projectOutput,
        resolvedOffset: 101,
      }),
    ).toBe(false);
  });
});

describe("parseForeignPortOwners", () => {
  const sharedPorts = [5432, 6379, 9000, 9001, 3003] as const;

  test("returns nothing when output is empty", () => {
    expect(
      parseForeignPortOwners({
        expectedProject: "stella-dev",
        output: "",
        sharedPorts,
      }),
    ).toEqual([]);
  });

  test("ignores containers from the expected compose project", () => {
    const output = [
      "stella-dev-postgres-1\tstella-dev\t0.0.0.0:5432->5432/tcp, [::]:5432->5432/tcp",
      "stella-dev-valkey-1\tstella-dev\t0.0.0.0:6379->6379/tcp",
    ].join("\n");

    expect(
      parseForeignPortOwners({
        expectedProject: "stella-dev",
        output,
        sharedPorts,
      }),
    ).toEqual([]);
  });

  test("flags foreign compose project containers holding shared ports", () => {
    const output = [
      "stella-1-table-export-postgres-1\tstella-1-table-export\t0.0.0.0:5432->5432/tcp, [::]:5432->5432/tcp",
      "stella-1-table-export-valkey-1\tstella-1-table-export\t0.0.0.0:6379->6379/tcp",
      "stella-1-table-export-gotenberg-1\tstella-1-table-export\t0.0.0.0:3003->3000/tcp",
      "snoopy-brewing-music-db-1\tsnoopy-brewing-music\t127.0.0.1:5434->5432/tcp",
    ].join("\n");

    expect(
      parseForeignPortOwners({
        expectedProject: "stella-dev",
        output,
        sharedPorts,
      }),
    ).toEqual([
      {
        composeProject: "stella-1-table-export",
        containerName: "stella-1-table-export-postgres-1",
        hostPort: 5432,
      },
      {
        composeProject: "stella-1-table-export",
        containerName: "stella-1-table-export-valkey-1",
        hostPort: 6379,
      },
      {
        composeProject: "stella-1-table-export",
        containerName: "stella-1-table-export-gotenberg-1",
        hostPort: 3003,
      },
    ]);
  });

  test("flags containers without a compose project label", () => {
    const output =
      "rogue-postgres\t\t0.0.0.0:5432->5432/tcp, [::]:5432->5432/tcp";

    expect(
      parseForeignPortOwners({
        expectedProject: "stella-dev",
        output,
        sharedPorts,
      }),
    ).toEqual([
      {
        composeProject: "",
        containerName: "rogue-postgres",
        hostPort: 5432,
      },
    ]);
  });

  test("only counts each host port once per container even with dual-stack mappings", () => {
    const output =
      "other-pg\tother-project\t0.0.0.0:5432->5432/tcp, [::]:5432->5432/tcp";

    expect(
      parseForeignPortOwners({
        expectedProject: "stella-dev",
        output,
        sharedPorts,
      }),
    ).toEqual([
      {
        composeProject: "other-project",
        containerName: "other-pg",
        hostPort: 5432,
      },
    ]);
  });
});

describe("requiredPortsForMode", () => {
  test("uses only the relevant ports for each mode", () => {
    const ports = portsForOffset(5);

    expect(requiredPortsForMode("dev:web", ports)).toEqual([3005]);
    expect(requiredPortsForMode("dev:api", ports)).toEqual([3006]);
    expect(requiredPortsForMode("dev", ports)).toEqual([3006, 3005]);
    expect(requiredPortsForMode("dev:desktop", ports)).toEqual([
      3006, 3005, 5182, 45_906,
    ]);
  });
});

describe("checkPortAvailabilityOnHosts", () => {
  test("requires every host probe to pass", async () => {
    const checkedPorts: { host: string; port: number }[] = [];

    const available = await checkPortAvailabilityOnHosts(
      3000,
      ["127.0.0.1", "0.0.0.0"],
      async (port, host) => {
        checkedPorts.push({ host, port });
        return host !== "0.0.0.0";
      },
    );

    expect(available).toBe(false);
    expect(checkedPorts).toEqual([
      { host: "127.0.0.1", port: 3000 },
      { host: "0.0.0.0", port: 3000 },
    ]);
  });
});

describe("findFirstAvailableOffset", () => {
  test("returns the starting offset when the requested ports are free", async () => {
    const offset = await findFirstAvailableOffset({
      checkReusableApiPort: async () => true,
      checkPortAvailability: async () => true,
      mode: "dev",
      startOffset: 0,
    });

    expect(offset).toBe(0);
  });

  test("advances until both web and API ports are free", async () => {
    const takenPorts = new Set([3000, 3001, 3002, 3003]);

    const offset = await findFirstAvailableOffset({
      checkReusableApiPort: async () => true,
      checkPortAvailability: async (port) => !takenPorts.has(port),
      mode: "dev",
      startOffset: 0,
    });

    expect(offset).toBe(4);
  });

  test("checks the web port and its companion API port in web-only mode", async () => {
    const seenPorts: number[] = [];

    const offset = await findFirstAvailableOffset({
      checkReusableApiPort: async () => true,
      checkPortAvailability: async (port) => {
        seenPorts.push(port);
        return true;
      },
      mode: "dev:web",
      startOffset: 3,
    });

    expect(offset).toBe(3);
    expect(seenPorts).toEqual([3003, 3004]);
  });

  test("skips web-only offsets whose companion API port is occupied by another service", async () => {
    const offset = await findFirstAvailableOffset({
      checkReusableApiPort: async (apiPort) => apiPort !== 3001,
      checkPortAvailability: async (port) => port !== 3001,
      mode: "dev:web",
      startOffset: 0,
    });

    expect(offset).toBe(2);
  });

  test("requires desktop view and bridge ports in desktop mode", async () => {
    const takenPorts = new Set([3000, 3001, 5177, 45_901]);

    const offset = await findFirstAvailableOffset({
      checkReusableApiPort: async () => true,
      checkPortAvailability: async (port) => !takenPorts.has(port),
      mode: "dev:desktop",
      startOffset: 0,
    });

    expect(offset).toBe(2);
  });
});

describe("worktree helpers", () => {
  test("detects linked worktrees by the .git file", () => {
    const mainRoot = createTempDir();
    const worktreeRoot = createTempDir();

    mkdirSync(path.resolve(mainRoot, ".git"), { recursive: true });
    writeFileSync(
      path.resolve(worktreeRoot, ".git"),
      "gitdir: /tmp/example/.git/worktrees/linked-worktree\n",
    );

    expect(isWorktreeCheckout(mainRoot)).toBe(false);
    expect(isWorktreeCheckout(worktreeRoot)).toBe(true);
  });

  test("resolves the main root from the common git dir", () => {
    const mainRoot = createTempDir();

    expect(resolveMainRootFromCommonDir(path.resolve(mainRoot, ".git"))).toBe(
      mainRoot,
    );
  });

  test("symlinks missing env files from the main worktree", () => {
    const mainRoot = createTempDir();
    const worktreeRoot = createTempDir();

    mkdirSync(path.resolve(mainRoot, "apps/api"), { recursive: true });
    mkdirSync(path.resolve(mainRoot, "apps/web"), { recursive: true });
    mkdirSync(path.resolve(worktreeRoot, "apps/api"), { recursive: true });
    mkdirSync(path.resolve(worktreeRoot, "apps/web"), { recursive: true });

    writeFileSync(path.resolve(mainRoot, "apps/api/.env"), "API=1\n");
    writeFileSync(path.resolve(mainRoot, "apps/web/.env"), "WEB=1\n");

    const createdLinks = ensureWorktreeEnvLinks({
      currentRoot: worktreeRoot,
      isWorktree: true,
      mainRoot,
    });

    expect(createdLinks).toBe(2);
    expect(
      Bun.file(path.resolve(worktreeRoot, "apps/api/.env")).size,
    ).toBeGreaterThan(0);
    expect(
      Bun.file(path.resolve(worktreeRoot, "apps/web/.env")).size,
    ).toBeGreaterThan(0);
  });

  test("migrates generated credentials before sharing the main env file", async () => {
    const mainRoot = createTempDir();
    const worktreeRoot = createTempDir();

    mkdirSync(path.resolve(mainRoot, "apps/api"), { recursive: true });
    mkdirSync(path.resolve(mainRoot, "apps/web"), { recursive: true });
    mkdirSync(path.resolve(worktreeRoot, "apps/api"), { recursive: true });
    mkdirSync(path.resolve(worktreeRoot, "apps/web"), { recursive: true });

    writeFileSync(
      path.resolve(mainRoot, "apps/api/.env"),
      'S3_ACCESS_KEY_ID="minioadmin"\nS3_SECRET_ACCESS_KEY="minioadmin"\n',
    );
    writeFileSync(path.resolve(mainRoot, "apps/web/.env"), "WEB=1\n");

    ensureWorktreeEnvLinks({
      currentRoot: worktreeRoot,
      isWorktree: true,
      mainRoot,
    });

    expect(
      await Bun.file(path.resolve(worktreeRoot, "apps/api/.env")).text(),
    ).toBe(
      'S3_ACCESS_KEY_ID="stella-rustfs-dev"\nS3_SECRET_ACCESS_KEY="stella-rustfs-dev-secret"\n',
    );
  });

  test("bootstraps missing env files from .env.example in the main checkout", () => {
    const mainRoot = createTempDir();

    mkdirSync(path.resolve(mainRoot, "apps/api"), { recursive: true });
    mkdirSync(path.resolve(mainRoot, "apps/web"), { recursive: true });

    writeFileSync(path.resolve(mainRoot, "apps/api/.env.example"), "API=1\n");
    writeFileSync(path.resolve(mainRoot, "apps/web/.env.example"), "WEB=1\n");

    const createdLinks = ensureWorktreeEnvLinks({
      currentRoot: mainRoot,
      isWorktree: false,
      mainRoot,
    });

    expect(createdLinks).toBe(2);
    expect(Bun.file(path.resolve(mainRoot, "apps/api/.env")).size).toBe(
      "API=1\n".length,
    );
    expect(Bun.file(path.resolve(mainRoot, "apps/web/.env")).size).toBe(
      "WEB=1\n".length,
    );
  });

  test("leaves custom pre-existing env files untouched", () => {
    const mainRoot = createTempDir();
    const worktreeRoot = createTempDir();

    mkdirSync(path.resolve(mainRoot, "apps/api"), { recursive: true });
    mkdirSync(path.resolve(mainRoot, "apps/web"), { recursive: true });
    mkdirSync(path.resolve(worktreeRoot, "apps/api"), { recursive: true });
    mkdirSync(path.resolve(worktreeRoot, "apps/web"), { recursive: true });

    writeFileSync(path.resolve(mainRoot, "apps/api/.env"), "API=1\n");
    writeFileSync(path.resolve(mainRoot, "apps/web/.env"), "WEB=1\n");
    writeFileSync(path.resolve(worktreeRoot, "apps/api/.env"), "LOCAL=1\n");

    const createdLinks = ensureWorktreeEnvLinks({
      currentRoot: worktreeRoot,
      isWorktree: true,
      mainRoot,
    });

    expect(createdLinks).toBe(1);
    expect(Bun.file(path.resolve(worktreeRoot, "apps/api/.env")).size).toBe(
      "LOCAL=1\n".length,
    );
  });

  test("migrates only the former generated S3 development credentials", () => {
    const generated = [
      'S3_ACCESS_KEY_ID="minioadmin"',
      'S3_SECRET_ACCESS_KEY="minioadmin"',
      'S3_BUCKET="stella"',
    ].join("\n");
    const custom = generated.replace(
      'S3_SECRET_ACCESS_KEY="minioadmin"',
      'S3_SECRET_ACCESS_KEY="custom"',
    );

    expect(migrateLegacyS3DevCredentials(generated)).toBe(
      [
        'S3_ACCESS_KEY_ID="stella-rustfs-dev"',
        'S3_SECRET_ACCESS_KEY="stella-rustfs-dev-secret"',
        'S3_BUCKET="stella"',
      ].join("\n"),
    );
    expect(migrateLegacyS3DevCredentials(custom)).toBe(custom);
  });
});

describe("legacy shared Docker service detection", () => {
  test("detects only the former object-store service", () => {
    expect(
      hasLegacyObjectStoreService([
        {
          exitCode: undefined,
          health: "healthy",
          service: "postgres",
          state: "running",
        },
        {
          exitCode: undefined,
          health: "healthy",
          service: "minio",
          state: "running",
        },
      ]),
    ).toBe(true);
    expect(
      hasLegacyObjectStoreService([
        {
          exitCode: undefined,
          health: "healthy",
          service: "rustfs",
          state: "running",
        },
      ]),
    ).toBe(false);
  });
});

describe("dev env factories", () => {
  test("uses the configured content encryption key without creating local state", () => {
    const rootDir = createTempDir();
    mkdirSync(path.resolve(rootDir, "apps/api"), { recursive: true });
    const configuredKey = "a".repeat(64);
    writeFileSync(
      path.resolve(rootDir, "apps/api/.env"),
      `CONTENT_ENCRYPTION_KEY=${configuredKey}\n`,
    );
    const steps = buildPersistentSteps({
      infraOffset: 0,
      infraPorts: infraPortsForOffset(0),
      mode: "dev:api",
      ports: portsForOffset(0),
      rootDir,
      seeded: false,
    });
    for (const step of steps.primary) {
      expect(step.env?.["CONTENT_ENCRYPTION_KEY"] === configuredKey).toBe(true);
    }
    expect(() =>
      statSync(devStatePath(rootDir, "content-encryption-key")),
    ).toThrow("ENOENT");
  });

  test("keeps a private persistent content encryption key per checkout", () => {
    const rootDir = createTempDir();
    const otherRootDir = createTempDir();
    const key = readOrCreateDevContentEncryptionKey(rootDir).unwrap();
    expect(key).toMatch(/^[a-f0-9]{64}$/u);
    expect(readOrCreateDevContentEncryptionKey(rootDir).unwrap() === key).toBe(
      true,
    );
    expect(
      readOrCreateDevContentEncryptionKey(otherRootDir).unwrap() === key,
    ).toBe(false);
    const steps = buildPersistentSteps({
      infraOffset: 0,
      infraPorts: infraPortsForOffset(0),
      mode: "dev:api",
      ports: portsForOffset(0),
      rootDir,
      seeded: false,
    });
    for (const step of steps.primary) {
      expect(step.env?.["CONTENT_ENCRYPTION_KEY"] === key).toBe(true);
    }
  });

  // Windows reports synthetic permission bits; file ACLs are not modes.
  test.skipIf(process.platform === "win32")(
    "creates the content encryption key readable by its owner only",
    () => {
      const rootDir = createTempDir();
      readOrCreateDevContentEncryptionKey(rootDir).unwrap();
      expect(
        statSync(devStatePath(rootDir, "content-encryption-key")).mode %
          0o1_0000,
      ).toBe(0o600);
    },
  );

  test("returns a typed error when local state cannot be created", () => {
    const rootDir = createTempDir();
    writeFileSync(path.join(rootDir, ".stella-dev"), "occupied");
    const result = readOrCreateDevContentEncryptionKey(rootDir);
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.message).toContain(
        "Could not initialize local content encryption key",
      );
      expect(result.error.cause).toBeInstanceOf(Error);
    }
  });

  test("requires a valid persisted content encryption key", () => {
    const rootDir = createTempDir();
    readOrCreateDevContentEncryptionKey(rootDir);
    writeFileSync(devStatePath(rootDir, "content-encryption-key"), "invalid");
    expect(() => readOrCreateDevContentEncryptionKey(rootDir).unwrap()).toThrow(
      "must contain a 32-byte hexadecimal key",
    );
  });

  test("a seeded stack searches its own Postgres corpus whatever apps/api/.env names", () => {
    const rootDir = createTempDir();
    mkdirSync(path.resolve(rootDir, "apps/api"), { recursive: true });
    writeFileSync(
      path.resolve(rootDir, "apps/api/.env"),
      "LEGAL_SEARCH_PROVIDER=corpus-index\n",
    );
    const apiProviders = (seeded: boolean) =>
      buildPersistentSteps({
        infraOffset: 0,
        infraPorts: infraPortsForOffset(0),
        mode: "dev:api",
        ports: portsForOffset(0),
        rootDir,
        seeded,
      }).primary.map((step) => step.env?.["LEGAL_SEARCH_PROVIDER"]);

    expect(apiProviders(true)).toEqual(["pg-fts", "pg-fts"]);
    expect(apiProviders(false)).toEqual(["corpus-index", "corpus-index"]);
  });

  test("seeded stacks disable scheduled writes while normal dev keeps schedules enabled", () => {
    const rootDir = createTempDir();
    mkdirSync(path.resolve(rootDir, "apps/api"), { recursive: true });
    writeFileSync(
      path.resolve(rootDir, "apps/api/.env"),
      "SCHEDULED_JOBS_MODE=enabled\n",
    );
    const scheduledJobsModes = (seeded: boolean) =>
      buildPersistentSteps({
        infraOffset: 0,
        infraPorts: infraPortsForOffset(0),
        mode: "dev:api",
        ports: portsForOffset(0),
        rootDir,
        seeded,
      }).primary.map((step) => step.env?.["SCHEDULED_JOBS_MODE"]);

    expect(scheduledJobsModes(true)).toEqual(["disabled", "disabled"]);
    expect(scheduledJobsModes(false)).toEqual(["enabled", "enabled"]);
  });

  test("keeps scheduled jobs inside the API process", () => {
    const rootDir = createTempDir();
    mkdirSync(path.resolve(rootDir, "apps/api"), { recursive: true });

    const apiSteps = buildPersistentSteps({
      infraOffset: 0,
      infraPorts: infraPortsForOffset(0),
      mode: "dev:api",
      ports: portsForOffset(0),
      rootDir,
      seeded: false,
    });
    const webSteps = buildPersistentSteps({
      infraOffset: 0,
      infraPorts: infraPortsForOffset(0),
      mode: "dev:web",
      ports: portsForOffset(0),
      rootDir,
      seeded: false,
    });

    expect(apiSteps.secondary).toEqual([]);
    expect(webSteps.secondary).toEqual([]);
  });

  test("starts the document processing worker with the API, after the readiness-checked steps", () => {
    const rootDir = createTempDir();
    mkdirSync(path.resolve(rootDir, "apps/api"), { recursive: true });
    const build = (mode: "dev" | "dev:api" | "dev:web") =>
      buildPersistentSteps({
        infraOffset: 10,
        infraPorts: infraPortsForOffset(10),
        mode,
        ports: portsForOffset(10),
        rootDir,
        seeded: false,
      });

    const devLabels = build("dev").primary.map((step) => step.label);
    expect(devLabels).toEqual([
      "API server",
      "Web server",
      "Document processing worker",
    ]);
    expect(build("dev:api").primary.map((step) => step.label)).toEqual([
      "API server",
      "Document processing worker",
    ]);
    expect(build("dev:web").primary.map((step) => step.label)).toEqual([
      "Web server",
    ]);

    const worker = build("dev").primary.at(-1);
    expect(worker?.cmd.slice(1)).toEqual([
      "--no-clear-screen",
      "--no-env-file",
      "--preload",
      "./src/dev/register-mock-ai.ts",
      "--watch",
      "src/scripts/document-processing-worker.ts",
    ]);
    expect(worker?.cwd).toBe(path.resolve(rootDir, "apps/api"));
    expect(worker?.env).toMatchObject({
      DATABASE_URL: "postgres://postgres:postgres@localhost:5442/stella",
      REDIS_URL: "redis://localhost:6389",
    });
  });

  test("prepares API databases by applying migrations", () => {
    const rootDir = createTempDir();
    mkdirSync(path.resolve(rootDir, "apps/api"), { recursive: true });

    const steps = buildPreparationSteps({
      infraOffset: 10,
      infraPorts: infraPortsForOffset(10),
      mode: "dev",
      ports: portsForOffset(10),
      rootDir,
      skipDbPush: false,
      skipInstall: true,
    });

    expect(steps).toHaveLength(2);
    expect(steps.at(0)?.cmd.slice(1)).toEqual([
      "run",
      "generate:capability-runtime",
    ]);
    expect(steps.at(1)?.cmd.slice(1)).toEqual(["run", "db:migrate"]);
    expect(steps.at(0)?.cwd).toBe(path.resolve(rootDir, "apps/api"));
    expect(steps.at(1)?.env).toMatchObject({
      DATABASE_URL: "postgres://postgres:postgres@localhost:5442/stella",
    });
    expect(steps.at(1)?.label).toBe("Applying database migrations");
  });

  test("every API dev mode prepares runtime sources even when installation and migrations are skipped", () => {
    const rootDir = createTempDir();
    for (const mode of ["dev", "dev:api", "dev:desktop", "dev:web"] as const) {
      const steps = buildPreparationSteps({
        infraOffset: 0,
        infraPorts: infraPortsForOffset(0),
        mode,
        ports: portsForOffset(0),
        rootDir,
        skipDbPush: true,
        skipInstall: true,
      });
      expect(steps.map(({ cmd }) => cmd.slice(1))).toEqual(
        mode === "dev:web" ? [] : [["run", "generate:capability-runtime"]],
      );
    }
  });

  test("threads computed ports into the API env without infra overrides at offset 0", () => {
    const result = createApiEnv({
      baseEnv: { KEEP_ME: "1" },
      infraOffset: 0,
      infraPorts: infraPortsForOffset(0),
      ports: {
        api: 3101,
        desktopBridge: 45_999,
        desktopView: 5199,
        web: 3100,
      },
    });

    expect(result).toMatchObject({
      BETTER_AUTH_COOKIE_PREFIX: "stella-dev-3101",
      BETTER_AUTH_URL: "http://localhost:3101",
      DB_LOAD_GATE_EBS_SIGNAL: "disabled",
      FRONTEND_URL: "http://localhost:3100",
      KEEP_ME: "1",
      NODE_ENV: "development",
      STELLA_API_PORT: "3101",
      STELLA_LOCAL_DEV: "1",
      STELLA_WEB_PORT: "3100",
    });
    expect(result).not.toHaveProperty("DATABASE_URL");
    expect(result).not.toHaveProperty("REDIS_URL");
  });

  test("threads shifted infra ports into the API env at non-zero offset", () => {
    expect(
      createApiEnv({
        baseEnv: {},
        infraOffset: 10,
        infraPorts: infraPortsForOffset(10),
        ports: {
          api: 3101,
          desktopBridge: 45_999,
          desktopView: 5199,
          web: 3100,
        },
      }),
    ).toMatchObject({
      DATABASE_URL: "postgres://postgres:postgres@localhost:5442/stella",
      GOTENBERG_URL: "http://localhost:3013",
      REDIS_URL: "redis://localhost:6389",
      S3_ENDPOINT: "http://localhost:9010",
    });
  });

  test("threads computed ports into the web env", () => {
    expect(
      createWebEnv({
        baseEnv: { KEEP_ME: "1" },
        ports: {
          api: 3101,
          desktopBridge: 45_999,
          desktopView: 5199,
          web: 3100,
        },
      }),
    ).toMatchObject({
      KEEP_ME: "1",
      STELLA_API_PORT: "3101",
      STELLA_WEB_PORT: "3100",
      VITE_API_URL: "http://localhost:3101",
      VITE_DESKTOP_BRIDGE_PORT: "45999",
    });
  });

  test("same-origin API opt-in overrides stale URLs together for every allocated port", () => {
    for (const offset of [0, 10, 80]) {
      const ports = portsForOffset(offset);
      const webEnv = createWebEnv({
        baseEnv: {
          DEV_API_PROXY_TARGET: "http://localhost:1",
          STELLA_DEV_SAME_ORIGIN_API: "1",
          VITE_BROWSER_API_URL: "http://localhost:2/api",
          VITE_PUBLIC_APP_URL: "http://localhost:3",
        },
        ports,
      });
      const browserApi = new URL(webEnv.VITE_BROWSER_API_URL ?? "");
      const app = new URL(webEnv.VITE_PUBLIC_APP_URL ?? "");
      expect(app.origin).toBe(`http://localhost:${String(ports.web)}`);
      expect(browserApi.origin).toBe(app.origin);
      expect(browserApi.pathname).toBe("/api");
      expect(webEnv.DEV_API_PROXY_TARGET).toBe(
        `http://127.0.0.1:${String(ports.api)}`,
      );
      expect(webEnv.VITE_API_URL).toBe(`http://localhost:${String(ports.api)}`);
    }
  });

  test("same-origin API routing requires an explicit opt-in", () => {
    for (const optIn of [undefined, "", "0"]) {
      const baseEnv = { STELLA_DEV_SAME_ORIGIN_API: optIn };
      const webEnv = createWebEnv({ baseEnv, ports: portsForOffset(10) });
      expect(webEnv).not.toHaveProperty("DEV_API_PROXY_TARGET");
      expect(webEnv).not.toHaveProperty("VITE_BROWSER_API_URL");
      expect(webEnv).not.toHaveProperty("VITE_PUBLIC_APP_URL");
    }
  });

  test("threads computed ports into the desktop env", () => {
    expect(
      createDesktopEnv({
        baseEnv: { KEEP_ME: "1" },
        ports: {
          api: 3101,
          desktopBridge: 45_999,
          desktopView: 5199,
          web: 3100,
        },
      }),
    ).toMatchObject({
      KEEP_ME: "1",
      STELLA_API_PORT: "3101",
      STELLA_DESKTOP_BRIDGE_PORT: "45999",
      STELLA_DESKTOP_VIEW_PORT: "5199",
      STELLA_WEB_PORT: "3100",
    });
  });
});

describe("browser behavior", () => {
  test("auto-opens only when the mode includes the web app", () => {
    expect(
      shouldAutoOpenBrowser({
        ci: "",
        mode: "dev",
        noBrowser: false,
      }),
    ).toBe(true);
    expect(
      shouldAutoOpenBrowser({
        ci: "",
        mode: "dev:desktop",
        noBrowser: false,
      }),
    ).toBe(true);
    expect(
      shouldAutoOpenBrowser({
        ci: "",
        mode: "dev:api",
        noBrowser: false,
      }),
    ).toBe(false);
    expect(
      shouldAutoOpenBrowser({
        ci: "",
        mode: "dev:web",
        noBrowser: true,
      }),
    ).toBe(false);
  });
});

describe("loadEnvFile and expandEnvMap", () => {
  test("correctly parses single and double quoted variables, and expands variables", () => {
    const rootDir = createTempDir();
    const envFilePath = path.resolve(rootDir, ".env");
    writeFileSync(
      envFilePath,
      [
        "PORT=3000",
        'DB_USER="postgres"',
        "DB_PASS='secret'",
        "DATABASE_URL=postgres://$DB_USER:$DB_PASS@localhost:$PORT/stella",
        "ESC_TEST=literal\\$value",
      ].join("\n"),
    );

    const parsed = loadEnvFile(envFilePath);
    expect(parsed).toEqual({
      PORT: "3000",
      DB_USER: "postgres",
      DB_PASS: "secret",
      DATABASE_URL: "postgres://$DB_USER:$DB_PASS@localhost:$PORT/stella",
      ESC_TEST: "literal\\$value",
    });

    const expanded = expandEnvMap(parsed);
    expect(expanded).toEqual({
      PORT: "3000",
      DB_USER: "postgres",
      DB_PASS: "secret",
      DATABASE_URL: "postgres://postgres:secret@localhost:3000/stella",
      ESC_TEST: "literal$value",
    });
  });

  test("handles nested dependencies recursively and respects overrides", () => {
    const parsed = {
      PUBLIC_URL: "$BETTER_AUTH_URL",
      BETTER_AUTH_URL: "http://localhost:$PORT",
      PORT: "3001",
    };

    // If PORT and BETTER_AUTH_URL are overwritten, expandEnvMap should resolve
    // using the overwritten values.
    const mergedWithOverrides = {
      ...parsed,
      PORT: "3005",
      BETTER_AUTH_URL: "http://127.0.0.1:3005",
    };

    const expanded = expandEnvMap(mergedWithOverrides);
    expect(expanded).toEqual({
      PUBLIC_URL: "http://127.0.0.1:3005",
      BETTER_AUTH_URL: "http://127.0.0.1:3005",
      PORT: "3005",
    });

    // Test recursive expansion of nested vars:
    const nested = {
      A: "$B",
      B: "$C",
      C: "nested-value",
    };
    expect(expandEnvMap(nested)).toEqual({
      A: "nested-value",
      B: "nested-value",
      C: "nested-value",
    });
  });
});

describe("startup failure reporting", () => {
  test("reports a seed failure and its cause chain, then exits non-zero", async () => {
    const reports: string[] = [];
    const exits: number[] = [];
    const failure = new Error("Seed step failed", {
      cause: new Error("relation does not exist", {
        cause: { pgCode: "42P01" },
      }),
    });

    await runMainAndExit({
      exit: (code) => {
        exits.push(code);
      },
      report: (message) => {
        reports.push(message);
      },
      run: async () => await Promise.reject(failure),
    });

    expect(exits).toEqual([1]);
    expect(reports).toHaveLength(1);
    expect(reports[0]).toContain("Seed step failed");
    expect(reports[0]).toContain("caused by: Error: relation does not exist");
    expect(reports[0]).toContain("42P01");
  });

  test("a failed group stop during cleanup is reported without throwing", () => {
    const reports: string[] = [];
    const groupStop = Result.err(
      new Error("Could not signal process group", { cause: "ESRCH" }),
    );

    expect(
      reportGroupStopFailure(groupStop, (m) => {
        reports.push(m);
      }),
    ).toBe(false);
    expect(reports.join("\n")).toContain("Could not signal process group");
    expect(reports.join("\n")).toContain("caused by: ESRCH");
  });

  test("formatting survives cyclic, empty and non-Error values", () => {
    const cyclic = new Error("a");
    cyclic.cause = cyclic;
    expect(formatErrorChain(cyclic)).toBe("Error: a");
    expect(formatErrorChain(undefined)).toBe("");
    expect(formatErrorChain(null)).toContain("null");
    expect(formatErrorChain(Object.create(null))).toBeString();
  });
});

describe("startup failure reporting with hostile errors", () => {
  const throwingGetter = (target: Error, key: "cause" | "message") =>
    Object.defineProperty(target, key, {
      get: () => {
        throw new Error("getter exploded");
      },
    });

  test("an Error whose cause getter throws is reported and exits 1", async () => {
    const reports: string[] = [];
    const exits: number[] = [];
    const failure = throwingGetter(new Error("Seed step failed"), "cause");

    await runMainAndExit({
      exit: (code) => {
        exits.push(code);
      },
      report: (message) => {
        reports.push(message);
      },
      run: async () => await Promise.reject(failure),
    });

    expect(exits).toEqual([1]);
    expect(reports.join("\n")).toContain("Seed step failed");
    expect(reports.join("\n")).toContain("<unreadable cause>");
  });

  test("an Error whose message getter throws is reported and exits 1", async () => {
    const reports: string[] = [];
    const exits: number[] = [];
    const failure = throwingGetter(new Error("hidden"), "message");

    await runMainAndExit({
      exit: (code) => {
        exits.push(code);
      },
      report: (message) => {
        reports.push(message);
      },
      run: async () => await Promise.reject(failure),
    });

    expect(exits).toEqual([1]);
    expect(reports.join("\n")).toContain("Error: <unreadable>");
  });

  test("exits 1 even when the reporter throws", async () => {
    const exits: number[] = [];

    await runMainAndExit({
      exit: (code) => {
        exits.push(code);
      },
      report: () => {
        throw new Error("stderr closed");
      },
      run: async () => await Promise.reject(new Error("boom")),
    });

    expect(exits).toEqual([1]);
  });
});
