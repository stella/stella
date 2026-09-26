#!/usr/bin/env bun
import { Result, panic } from "better-result";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer, Socket } from "node:net";
import path from "node:path";

import { Temporal } from "@stll/time";

import {
  DEFAULT_INFRA_PORTS,
  DEFAULT_PORTS,
  MAX_PORT_OFFSET,
  type DevMode,
  readDevRunnerConfig,
} from "./dev-runner-config";

const ENV_FILE_SPECS = [
  {
    example: "apps/api/.env.example",
    path: "apps/api/.env",
  },
  {
    example: "apps/web/.env.example",
    path: "apps/web/.env",
  },
] as const;
const PORT_PROBE_HOSTS = ["127.0.0.1", "0.0.0.0"] as const;
const DEFAULT_HTTP_PROBE_TIMEOUT_MS = 1500;
const DEFAULT_HTTP_READY_TIMEOUT_MS = 120_000;
const DEFAULT_OPEN_BROWSER_TIMEOUT_MS = 5000;
const CHILD_SHUTDOWN_GRACE_PERIOD_MS = 12_000;
const CHILD_FORCE_EXIT_TIMEOUT_MS = 2000;
const FORCE_KILL_SIGNAL = "SIGKILL";
const SHARED_DOCKER_PROJECT_BASE = "stella-dev";
const SHARED_DOCKER_HEALTHY_SERVICES = [
  "postgres",
  "valkey",
  "rustfs",
  "gotenberg",
] as const;
const SHARED_DOCKER_COMPLETED_SERVICES = ["rustfs-setup"] as const;
const DOCKER_PROJECT_WORKTREE_HASH_LENGTH = 12;
const STELLA_DOCKER_PROJECT_PATTERN =
  /^stella-dev(?:-\d+(?:-[a-f0-9]{12})?)?$/u;
const LEGACY_OBJECT_STORE_SERVICE = "minio";
const RUSTFS_S3_DEV_ACCESS_KEY = "stella-rustfs-dev";
const RUSTFS_S3_DEV_SECRET_KEY = "stella-rustfs-dev-secret";
export const MAX_HASH_OFFSET = 400;
const PORT_SEARCH_LIMIT = 2000;
// The web app renders via TanStack Start SSR (root document from __root.tsx),
// which mounts into <body> directly — there is no `<div id="app">` SPA mount.
// Match the shell's stable prepaint-init script, not the user-facing <title>
// (which can change with branding), so readiness reflects a real rendered shell.
const WEB_HTML_MARKER = 'src="/prepaint-init.js"';

export type InfraPorts = {
  gotenberg: number;
  postgres: number;
  rustfs: number;
  rustfsConsole: number;
  valkey: number;
};

export type OffsetConfig = {
  devInstance: string | undefined;
  isWorktree: boolean;
  portOffset: number | undefined;
  worktreePath: string;
};

export type ResolvedOffset = {
  offset: number;
  source: string;
};

export type DevPorts = {
  api: number;
  desktopBridge: number;
  desktopView: number;
  web: number;
};

type GitContext = {
  canonicalRoot: string;
  commonGitDir: string;
  currentRoot: string;
  isWorktree: boolean;
  mainRoot: string;
};

type Step = {
  cmd: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  label: string;
};

type RunningStep = Step & {
  child: Bun.Subprocess;
};

type StoppableChild = Pick<Bun.Subprocess, "exited" | "kill">;

type StoppableStep = {
  child: StoppableChild;
  label: string;
};

type StopChildrenOptions = {
  children: readonly StoppableStep[];
  wait?: (durationMs: number) => Promise<void>;
};

type HttpReadinessCheck = {
  label: string;
  timeoutMs?: number;
  url: string;
  validate: (
    response: Response,
    bodyText: string,
  ) => Promise<string | undefined> | string | undefined;
};

// The process backing this readiness check: if it dies before the check
// passes, waitForHttpReadiness fails fast with the crash instead of
// polling until the HTTP timeout.
type HttpReadinessWaitOptions = HttpReadinessCheck & {
  child: Bun.Subprocess;
};

export type DockerComposeServiceStatus = {
  exitCode: number | undefined;
  health: string | undefined;
  service: string;
  state: string;
};

type PersistentSteps = {
  primary: Step[];
  secondary: Step[];
};

type ReadinessChecks = {
  primary: HttpReadinessCheck[];
  secondary: HttpReadinessCheck[];
};

type CheckReusableApiPort = (apiPort: number) => Promise<boolean>;

const modeIncludesApi = (mode: DevMode) =>
  mode === "dev" || mode === "dev:api" || mode === "dev:desktop";

const modeIncludesDesktop = (mode: DevMode) => mode === "dev:desktop";

const modeIncludesWeb = (mode: DevMode) =>
  mode === "dev" || mode === "dev:web" || mode === "dev:desktop";

const hashSeed = (seed: string) => {
  let hash = 0;

  for (const char of seed) {
    const codePoint = char.codePointAt(0) ?? 0;
    hash = (hash * 33 + codePoint) % Number.MAX_SAFE_INTEGER;
  }

  return hash;
};

const resolveCommandPath = (command: string) => Bun.which(command) ?? command;

const resolveMaybeRelativePath = (cwd: string, value: string) =>
  path.isAbsolute(value) ? value : path.resolve(cwd, value);

const validateOffset = (offset: number, source: string) => {
  if (!Number.isInteger(offset) || offset < 0 || offset > MAX_PORT_OFFSET) {
    panic(
      `${source} must be an integer between 0 and ${String(MAX_PORT_OFFSET)}`,
    );
  }
};

export const resolveOffset = ({
  devInstance,
  isWorktree,
  portOffset,
  worktreePath,
}: OffsetConfig): ResolvedOffset => {
  if (portOffset !== undefined) {
    validateOffset(portOffset, "STELLA_PORT_OFFSET");

    return {
      offset: portOffset,
      source: `STELLA_PORT_OFFSET=${String(portOffset)}`,
    };
  }

  const configuredInstance = devInstance?.trim();
  if (configuredInstance) {
    if (/^\d+$/u.test(configuredInstance)) {
      const resolvedOffset = Number.parseInt(configuredInstance, 10);
      validateOffset(resolvedOffset, "numeric STELLA_DEV_INSTANCE");

      return {
        offset: resolvedOffset,
        source: `numeric STELLA_DEV_INSTANCE=${configuredInstance}`,
      };
    }

    return {
      offset: (hashSeed(configuredInstance) % MAX_HASH_OFFSET) + 1,
      source: `hashed STELLA_DEV_INSTANCE=${configuredInstance}`,
    };
  }

  if (!isWorktree) {
    return {
      offset: 0,
      source: "default ports",
    };
  }

  // The seed is the worktree's canonical path, never the branch: a checkout
  // switching branches must keep the ports its running stack and its
  // port-pinned local state (Better Auth OAuth resource policies, cookies)
  // were set up on.
  return {
    offset: (hashSeed(worktreePath) % MAX_HASH_OFFSET) + 1,
    source: `hashed worktree path=${worktreePath}`,
  };
};

export const infraPortsForOffset = (offset: number): InfraPorts => ({
  gotenberg: DEFAULT_INFRA_PORTS.gotenberg + offset,
  postgres: DEFAULT_INFRA_PORTS.postgres + offset,
  rustfs: DEFAULT_INFRA_PORTS.rustfs + offset,
  rustfsConsole: DEFAULT_INFRA_PORTS.rustfsConsole + offset,
  valkey: DEFAULT_INFRA_PORTS.valkey + offset,
});

const legacyDockerProjectName = (infraOffset: number) =>
  infraOffset === 0
    ? SHARED_DOCKER_PROJECT_BASE
    : `${SHARED_DOCKER_PROJECT_BASE}-${String(infraOffset)}`;

export const dockerProjectName = ({
  infraOffset,
  isWorktree,
  worktreePath,
}: {
  infraOffset: number;
  isWorktree: boolean;
  worktreePath: string;
}) => {
  if (!isWorktree) {
    return legacyDockerProjectName(infraOffset);
  }

  const worktreeHash = createHash("sha256")
    .update(worktreePath)
    .digest("hex")
    .slice(0, DOCKER_PROJECT_WORKTREE_HASH_LENGTH);
  return `${SHARED_DOCKER_PROJECT_BASE}-${String(infraOffset)}-${worktreeHash}`;
};

export const portsForOffset = (offset: number): DevPorts => ({
  api: DEFAULT_PORTS.api + offset,
  desktopBridge: DEFAULT_PORTS.desktopBridge + offset,
  desktopView: DEFAULT_PORTS.desktopView + offset,
  web: DEFAULT_PORTS.web + offset,
});

export const requiredPortsForMode = (
  mode: DevMode,
  ports: DevPorts,
): number[] => {
  const requiredPorts: number[] = [];

  if (modeIncludesApi(mode)) {
    requiredPorts.push(ports.api);
  }

  if (modeIncludesWeb(mode)) {
    requiredPorts.push(ports.web);
  }

  if (modeIncludesDesktop(mode)) {
    requiredPorts.push(ports.desktopView, ports.desktopBridge);
  }

  return requiredPorts;
};

const canListenOnHost = async (port: number, host: string) =>
  await new Promise<boolean>((resolve) => {
    const server = createServer();
    server.unref();

    const finish = (result: boolean) => {
      server.removeAllListeners();
      resolve(result);
    };

    server.once("error", () => {
      try {
        server.close();
      } catch {
        // Best-effort cleanup only; the probe already failed.
      }
      finish(false);
    });

    server.listen(port, host, () => {
      server.close(() => {
        finish(true);
      });
    });
  });

export const checkPortAvailabilityOnHosts = async (
  port: number,
  hosts: readonly string[] = PORT_PROBE_HOSTS,
  checkPort = canListenOnHost,
) => {
  for (const host of hosts) {
    if (!(await checkPort(port, host))) {
      return false;
    }
  }

  return true;
};

// A probe reports why it failed, not just that it did: Docker Desktop's port
// forwarder can reset one published port while the container still reports
// healthy, and only the per-service error makes that visible.
type ProbeOutcome = { error: string; status: "failed" } | { status: "ok" };

const describeProbeError = (error: unknown) => {
  if (!(error instanceof Error)) {
    return String(error);
  }

  return error.name === "TimeoutError" ? "timeout" : error.message;
};

const connectToPort = async ({
  host = "127.0.0.1",
  port,
  timeoutMs = 750,
}: {
  host?: string;
  port: number;
  timeoutMs?: number;
}) =>
  await new Promise<ProbeOutcome>((resolve) => {
    const socket = new Socket();

    const finish = (outcome: ProbeOutcome) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(outcome);
    };

    socket.once("connect", () => {
      finish({ status: "ok" });
    });

    socket.once("error", (error: Error) => {
      finish({ error: error.message, status: "failed" });
    });

    socket.setTimeout(timeoutMs, () => {
      finish({ error: "timeout", status: "failed" });
    });

    socket.connect(port, host);
  });

const probeHttpHealth = async (url: string): Promise<ProbeOutcome> => {
  try {
    const response = await fetch(url, {
      method: "GET",
      signal: AbortSignal.timeout(DEFAULT_HTTP_PROBE_TIMEOUT_MS),
    });

    return response.ok
      ? { status: "ok" }
      : { error: `HTTP ${String(response.status)}`, status: "failed" };
  } catch (error) {
    return { error: describeProbeError(error), status: "failed" };
  }
};

const readJson = (bodyText: string): unknown => {
  try {
    const parsed: unknown = JSON.parse(bodyText);
    return parsed;
  } catch {
    return null;
  }
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

export type SharedDockerService =
  (typeof SHARED_DOCKER_HEALTHY_SERVICES)[number];

export type SharedServiceProbe = ProbeOutcome & {
  service: SharedDockerService;
};

const probeSharedDockerServices = async (
  infraPorts: InfraPorts,
): Promise<SharedServiceProbe[]> => {
  const probes = {
    gotenberg: probeHttpHealth(
      `http://127.0.0.1:${String(infraPorts.gotenberg)}/health`,
    ),
    postgres: connectToPort({ port: infraPorts.postgres }),
    rustfs: probeHttpHealth(
      `http://127.0.0.1:${String(infraPorts.rustfs)}/health`,
    ),
    valkey: connectToPort({ port: infraPorts.valkey }),
  } satisfies Record<SharedDockerService, Promise<ProbeOutcome>>;

  return await Promise.all(
    SHARED_DOCKER_HEALTHY_SERVICES.map(async (service) => ({
      service,
      ...(await probes[service]),
    })),
  );
};

export const describeFailedProbes = (
  probes: readonly SharedServiceProbe[],
): string[] => {
  const failures: string[] = [];

  for (const probe of probes) {
    if (probe.status === "failed") {
      failures.push(`${probe.service}: ${probe.error}`);
    }
  }

  return failures;
};

const isHealthyApiPort = async (port: number) => {
  try {
    const response = await fetch(`${apiUrlForPort(port)}/health`, {
      method: "GET",
      signal: AbortSignal.timeout(DEFAULT_HTTP_PROBE_TIMEOUT_MS),
    });
    const bodyText = await response.text();
    return validateApiHealth(response, bodyText) === undefined;
  } catch {
    return false;
  }
};

const sharedInfraPortList = (infraPorts: InfraPorts) => [
  infraPorts.postgres,
  infraPorts.valkey,
  infraPorts.rustfs,
  infraPorts.rustfsConsole,
  infraPorts.gotenberg,
];

const areSharedDockerPortsFree = async (infraPorts: InfraPorts) => {
  const availability = await Promise.all(
    sharedInfraPortList(infraPorts).map(
      async (port) => await checkPortAvailabilityOnHosts(port),
    ),
  );

  return availability.every(Boolean);
};

export type ForeignPortOwner = {
  composeProject: string;
  containerName: string;
  hostPort: number;
};

export const parseForeignPortOwners = ({
  expectedProject,
  output,
  sharedPorts,
}: {
  expectedProject: string;
  output: string;
  sharedPorts: readonly number[];
}): ForeignPortOwner[] => {
  const portSet = new Set(sharedPorts);
  const foreign: ForeignPortOwner[] = [];

  for (const line of output.split("\n")) {
    if (!line) {
      continue;
    }
    const [containerName, composeProject, portsField] = line.split("\t");
    if (!containerName || composeProject === expectedProject) {
      continue;
    }

    const seen = new Set<number>();
    for (const match of (portsField ?? "").matchAll(/:(?<hostPort>\d+)->/gu)) {
      const hostPort = Number.parseInt(match.groups?.["hostPort"] ?? "", 10);
      if (
        Number.isNaN(hostPort) ||
        !portSet.has(hostPort) ||
        seen.has(hostPort)
      ) {
        continue;
      }
      seen.add(hostPort);
      foreign.push({
        composeProject: composeProject ?? "",
        containerName,
        hostPort,
      });
    }
  }

  return foreign;
};

const findForeignContainersOnSharedPorts = ({
  dockerProject,
  infraPorts,
  rootDir,
}: {
  dockerProject: string;
  infraPorts: InfraPorts;
  rootDir: string;
}) =>
  parseForeignPortOwners({
    expectedProject: dockerProject,
    output: runCommandText({
      cmd: [
        resolveCommandPath("docker"),
        "ps",
        "--format",
        '{{.Names}}\t{{.Label "com.docker.compose.project"}}\t{{.Ports}}',
      ],
      cwd: rootDir,
    }),
    sharedPorts: sharedInfraPortList(infraPorts),
  });

const dockerComposeEnv = (infraPorts: InfraPorts) => ({
  ...process.env,
  STELLA_GOTENBERG_HOST_PORT: String(infraPorts.gotenberg),
  STELLA_PG_HOST_PORT: String(infraPorts.postgres),
  STELLA_RUSTFS_CONSOLE_PORT: String(infraPorts.rustfsConsole),
  STELLA_RUSTFS_HOST_PORT: String(infraPorts.rustfs),
  STELLA_VALKEY_HOST_PORT: String(infraPorts.valkey),
});

const DOCKER_SERVICES_READY_TIMEOUT_MS = 30_000;
const DOCKER_SERVICES_POLL_INTERVAL_MS = 500;
const SHARED_DOCKER_SERVICE_NAMES = [
  ...SHARED_DOCKER_HEALTHY_SERVICES,
  ...SHARED_DOCKER_COMPLETED_SERVICES,
].join(", ");

const stringField = (record: Record<string, unknown>, key: string) => {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
};

const numberField = (record: Record<string, unknown>, key: string) => {
  const value = record[key];
  if (typeof value === "number") {
    return value;
  }
  if (typeof value !== "string") {
    return undefined;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? undefined : parsed;
};

const normalizeComposeServiceStatus = (
  value: unknown,
): DockerComposeServiceStatus | null => {
  if (!isRecord(value)) {
    return null;
  }

  const service = stringField(value, "Service");
  if (!service) {
    return null;
  }

  return {
    exitCode: numberField(value, "ExitCode"),
    health: stringField(value, "Health"),
    service,
    state: stringField(value, "State") ?? "",
  };
};

export const hasLegacyObjectStoreService = (
  statuses: readonly DockerComposeServiceStatus[],
) => statuses.some(({ service }) => service === LEGACY_OBJECT_STORE_SERVICE);

export const parseDockerComposePsJson = (output: string) => {
  const trimmed = output.trim();
  if (!trimmed) {
    return [];
  }

  const parsed = readJson(trimmed);
  if (Array.isArray(parsed)) {
    const statuses: DockerComposeServiceStatus[] = [];
    for (const value of parsed) {
      const status = normalizeComposeServiceStatus(value);
      if (status) {
        statuses.push(status);
      }
    }
    return statuses;
  }

  const statuses: DockerComposeServiceStatus[] = [];
  for (const line of trimmed.split(/\r?\n/u)) {
    const status = normalizeComposeServiceStatus(readJson(line));
    if (status) {
      statuses.push(status);
    }
  }

  return statuses;
};

const statusByService = (statuses: readonly DockerComposeServiceStatus[]) => {
  const statusMap = new Map<string, DockerComposeServiceStatus>();
  for (const status of statuses) {
    statusMap.set(status.service, status);
  }
  return statusMap;
};

export const getSharedDockerServicesWaitFailure = (
  statuses: readonly DockerComposeServiceStatus[],
) => {
  const statusesByService = statusByService(statuses);

  for (const service of SHARED_DOCKER_HEALTHY_SERVICES) {
    const status = statusesByService.get(service);
    if (!status) {
      return `${service} status is missing`;
    }
    if (status.state !== "running") {
      return `${service} is ${status.state || "not running"}`;
    }
    if (status.health !== "healthy") {
      return `${service} is ${status.health ? `health=${status.health}` : "not reporting health"}`;
    }
  }

  for (const service of SHARED_DOCKER_COMPLETED_SERVICES) {
    const status = statusesByService.get(service);
    if (!status) {
      return `${service} status is missing`;
    }
    if (status.state === "exited" && status.exitCode === 0) {
      continue;
    }
    if (status.state === "exited") {
      return `${service} exited with code ${String(status.exitCode ?? "unknown")}`;
    }
    return `${service} has not completed yet (state=${status.state || "unknown"})`;
  }

  return undefined;
};

type DockerComposeCommandOptions = {
  args: readonly string[];
  composeFile?: string;
  dockerProject: string;
};

const dockerComposeCommand = ({
  args,
  composeFile,
  dockerProject,
}: DockerComposeCommandOptions) => [
  resolveCommandPath("docker"),
  "compose",
  "--project-name",
  dockerProject,
  ...(composeFile ? ["--file", composeFile] : []),
  "--profile",
  "dev",
  ...args,
];

export const projectsForDeletedWorktrees = ({
  output,
  pathExists = existsSync,
}: {
  output: string;
  pathExists?: (candidate: string) => boolean;
}) => {
  const ownershipByProject = parseDockerProjectOwnership(output);

  return [...ownershipByProject]
    .filter(
      ([, { complete, worktreePaths }]) =>
        complete &&
        worktreePaths.size > 0 &&
        [...worktreePaths].every((worktreePath) => !pathExists(worktreePath)),
    )
    .map(([name]) => name)
    .toSorted();
};

type DockerProjectOwnership = {
  complete: boolean;
  worktreePaths: Set<string>;
};

const parseDockerProjectOwnership = (output: string) => {
  const ownershipByProject = new Map<string, DockerProjectOwnership>();

  for (const line of output.split("\n")) {
    const [name, worktreePath] = line.split("\t");
    if (!name || !STELLA_DOCKER_PROJECT_PATTERN.test(name)) {
      continue;
    }

    const ownership = ownershipByProject.get(name) ?? {
      complete: true,
      worktreePaths: new Set<string>(),
    };
    if (worktreePath) {
      ownership.worktreePaths.add(worktreePath);
    } else {
      ownership.complete = false;
    }
    ownershipByProject.set(name, ownership);
  }

  return ownershipByProject;
};

export const dockerProjectBelongsToWorktree = ({
  dockerProject,
  output,
  worktreePaths,
}: {
  dockerProject: string;
  output: string;
  worktreePaths: readonly string[];
}) => {
  const ownership = parseDockerProjectOwnership(output).get(dockerProject);
  return (
    ownership?.complete === true &&
    ownership.worktreePaths.size === 1 &&
    worktreePaths.some((worktreePath) =>
      ownership.worktreePaths.has(worktreePath),
    )
  );
};

export const hasConflictingDockerOwner = ({
  dockerProject,
  initialOffset,
  output,
  resolvedOffset,
}: {
  dockerProject: string;
  initialOffset: number;
  output: string;
  resolvedOffset: number;
}) =>
  resolvedOffset !== initialOffset &&
  parseDockerProjectOwnership(output).has(dockerProject);

export const dockerComposeDownCommand = ({
  composeFile,
  dockerProject,
}: {
  composeFile: string;
  dockerProject: string;
}) =>
  dockerComposeCommand({
    args: ["down", "--remove-orphans"],
    composeFile,
    dockerProject,
  });

const readDockerComposeProjectOwnershipOutput = (rootDir: string) =>
  runCommandText({
    cmd: [
      resolveCommandPath("docker"),
      "ps",
      "--all",
      "--format",
      '{{.Label "com.docker.compose.project"}}\t{{.Label "com.docker.compose.project.working_dir"}}',
    ],
    cwd: rootDir,
  });

const stopDockerProject = ({
  composeFile,
  dockerProject,
  rootDir,
}: {
  composeFile: string;
  dockerProject: string;
  rootDir: string;
}) => {
  runStep({
    cmd: dockerComposeDownCommand({ composeFile, dockerProject }),
    cwd: rootDir,
    label: `Stopping Docker project ${dockerProject}`,
  });
};

const removeProjectsForDeletedWorktrees = ({
  composeFile,
  ownershipOutput,
  rootDir,
}: {
  composeFile: string;
  ownershipOutput: string;
  rootDir: string;
}) => {
  const deletedWorktreeProjects = projectsForDeletedWorktrees({
    output: ownershipOutput,
  });

  for (const dockerProject of deletedWorktreeProjects) {
    stopDockerProject({
      composeFile,
      dockerProject,
      rootDir,
    });
  }
};

const readSharedDockerServiceStatuses = ({
  dockerProject,
  infraPorts,
  rootDir,
}: {
  dockerProject: string;
  infraPorts: InfraPorts;
  rootDir: string;
}) =>
  parseDockerComposePsJson(
    runCommandText({
      cmd: dockerComposeCommand({
        args: ["ps", "--all", "--format", "json"],
        dockerProject,
      }),
      cwd: rootDir,
      env: dockerComposeEnv(infraPorts),
    }),
  );

const waitForSharedDockerServices = async ({
  dockerProject,
  infraPorts,
  rootDir,
}: {
  dockerProject: string;
  infraPorts: InfraPorts;
  rootDir: string;
}) => {
  const startedAt = Temporal.Now.instant().epochMilliseconds;
  let lastFailure = "service status has not been read yet";

  while (
    Temporal.Now.instant().epochMilliseconds - startedAt <
    DOCKER_SERVICES_READY_TIMEOUT_MS
  ) {
    const statuses = readSharedDockerServiceStatuses({
      dockerProject,
      infraPorts,
      rootDir,
    });
    const failure = getSharedDockerServicesWaitFailure(statuses);
    if (!failure) {
      return;
    }
    lastFailure = failure;
    await Bun.sleep(DOCKER_SERVICES_POLL_INTERVAL_MS);
  }

  panic(
    `Timed out after ${String(DOCKER_SERVICES_READY_TIMEOUT_MS / 1000)}s waiting for shared Docker services (${SHARED_DOCKER_SERVICE_NAMES}) to become ready: ${lastFailure}.`,
  );
};

const ensureDockerServices = async ({
  dockerProject,
  infraPorts,
  markStarted,
  rootDir,
}: {
  dockerProject: string;
  infraPorts: InfraPorts;
  markStarted: () => void;
  rootDir: string;
}) => {
  if (
    hasLegacyObjectStoreService(
      readSharedDockerServiceStatuses({
        dockerProject,
        infraPorts,
        rootDir,
      }),
    )
  ) {
    runStep({
      cmd: dockerComposeCommand({
        args: ["down", "--remove-orphans"],
        dockerProject,
      }),
      cwd: rootDir,
      env: dockerComposeEnv(infraPorts),
      label: "Replacing the legacy object-store service",
    });
  }

  const foreignOwners = findForeignContainersOnSharedPorts({
    dockerProject,
    infraPorts,
    rootDir,
  });
  if (foreignOwners.length > 0) {
    const detail = foreignOwners
      .map(
        ({ composeProject, containerName, hostPort }) =>
          `  - host port ${String(hostPort)}: ${containerName} (project ${composeProject || "<none>"})`,
      )
      .join("\n");
    panic(
      `Shared Docker ports are held by containers from another Compose project:\n${detail}\nStop the conflicting stack, or use --infra-offset to shift stella's infra ports.`,
    );
  }

  const failedProbes = describeFailedProbes(
    await probeSharedDockerServices(infraPorts),
  );

  if (failedProbes.length === 0) {
    const currentFailure = getSharedDockerServicesWaitFailure(
      readSharedDockerServiceStatuses({
        dockerProject,
        infraPorts,
        rootDir,
      }),
    );
    if (!currentFailure) {
      console.log("==> Reusing healthy shared Docker services...");
      return;
    }

    console.log(
      `==> Shared Docker services are running but setup is incomplete (${currentFailure}); reconciling Compose project...`,
    );
  } else if (!(await areSharedDockerPortsFree(infraPorts))) {
    panic(
      `Shared Docker ports (${sharedInfraPortList(infraPorts).join(", ")}) are already allocated, but the shared dev services did not pass health checks (${failedProbes.join("; ")}). Stop the conflicting stack, or use --infra-offset to shift stella's infra ports.`,
    );
  }

  // We deliberately omit `--wait` here: the `dev` profile includes the
  // `rustfs-setup` one-shot init container, which exits 0 after creating the
  // bucket. Compose's `--wait` treats that exit as a failure even on success,
  // so we run detached and poll the four core services ourselves. The
  // one-shot setup container is polled separately and must exit successfully.
  markStarted();
  runStep({
    cmd: dockerComposeCommand({ args: ["up", "-d"], dockerProject }),
    cwd: rootDir,
    env: dockerComposeEnv(infraPorts),
    label: "Starting Docker services",
  });

  console.log("==> Waiting for shared Docker services to become ready...");
  await waitForSharedDockerServices({
    dockerProject,
    infraPorts,
    rootDir,
  });
};

export const findFirstAvailableOffset = async ({
  checkReusableApiPort = isHealthyApiPort,
  checkPortAvailability = checkPortAvailabilityOnHosts,
  mode,
  startOffset,
}: {
  checkReusableApiPort?: CheckReusableApiPort;
  checkPortAvailability?: (port: number) => Promise<boolean>;
  mode: DevMode;
  startOffset: number;
}) => {
  for (
    let offset = startOffset;
    offset <= startOffset + PORT_SEARCH_LIMIT;
    offset++
  ) {
    const ports = portsForOffset(offset);
    const availability = await Promise.all(
      requiredPortsForMode(mode, ports).map(
        async (port) => await checkPortAvailability(port),
      ),
    );
    if (availability.every(Boolean)) {
      if (mode === "dev:web") {
        const apiPortIsFree = await checkPortAvailability(ports.api);
        if (!apiPortIsFree && !(await checkReusableApiPort(ports.api))) {
          continue;
        }
      }

      return offset;
    }
  }

  return panic(
    `Could not find a free port offset for ${mode} after ${String(PORT_SEARCH_LIMIT)} attempts.`,
  );
};

export const isWorktreeCheckout = (rootDir: string) => {
  const gitPath = path.resolve(rootDir, ".git");
  return existsSync(gitPath) && lstatSync(gitPath).isFile();
};

export const resolveMainRootFromCommonDir = (commonGitDir: string) =>
  path.resolve(commonGitDir, "..");

export const migrateLegacyS3DevCredentials = (contents: string) => {
  const accessKey = /^S3_ACCESS_KEY_ID=(?:"minioadmin"|minioadmin)$/mu;
  const secretKey = /^S3_SECRET_ACCESS_KEY=(?:"minioadmin"|minioadmin)$/mu;
  if (!accessKey.test(contents) || !secretKey.test(contents)) {
    return contents;
  }

  return contents
    .replace(accessKey, () => `S3_ACCESS_KEY_ID="${RUSTFS_S3_DEV_ACCESS_KEY}"`)
    .replace(
      secretKey,
      () => `S3_SECRET_ACCESS_KEY="${RUSTFS_S3_DEV_SECRET_KEY}"`,
    );
};

const migrateEnvFileIfNeeded = (filePath: string, specPath: string) => {
  if (specPath !== "apps/api/.env") {
    return;
  }
  const contents = readFileSync(filePath, "utf-8");
  const migrated = migrateLegacyS3DevCredentials(contents);
  if (migrated !== contents) {
    writeFileSync(filePath, migrated);
  }
};

export const ensureWorktreeEnvLinks = ({
  currentRoot,
  isWorktree,
  mainRoot,
}: {
  currentRoot: string;
  isWorktree: boolean;
  mainRoot: string;
}) => {
  let preparedFiles = 0;

  for (const spec of ENV_FILE_SPECS) {
    const targetPath = path.resolve(currentRoot, spec.path);
    if (existsSync(targetPath)) {
      migrateEnvFileIfNeeded(targetPath, spec.path);
      continue;
    }

    const mainEnvPath = path.resolve(mainRoot, spec.path);
    if (isWorktree && existsSync(mainEnvPath)) {
      migrateEnvFileIfNeeded(mainEnvPath, spec.path);
      mkdirSync(path.dirname(targetPath), { recursive: true });
      try {
        symlinkSync(mainEnvPath, targetPath);
      } catch {
        copyFileSync(mainEnvPath, targetPath);
      }
      preparedFiles++;
      continue;
    }

    const examplePath = path.resolve(currentRoot, spec.example);
    if (!existsSync(examplePath)) {
      continue;
    }

    mkdirSync(path.dirname(targetPath), { recursive: true });
    copyFileSync(examplePath, targetPath);
    preparedFiles++;
  }

  return preparedFiles;
};

const apiUrlForPort = (port: number) => `http://127.0.0.1:${String(port)}`;
const webUrlForPort = (port: number) => `http://localhost:${String(port)}`;
const desktopBridgeUrlForPort = (port: number) =>
  `http://127.0.0.1:${String(port)}`;
const desktopViewUrlForPort = (port: number) =>
  `http://127.0.0.1:${String(port)}`;

export const createApiEnv = ({
  baseEnv,
  infraOffset,
  infraPorts,
  ports,
}: {
  baseEnv: NodeJS.ProcessEnv;
  infraOffset: number;
  infraPorts: InfraPorts;
  ports: DevPorts;
}) => ({
  ...baseEnv,
  BETTER_AUTH_COOKIE_PREFIX: `stella-dev-${String(ports.api)}`,
  BETTER_AUTH_URL: `http://localhost:${String(ports.api)}`,
  FRONTEND_URL: `http://localhost:${String(ports.web)}`,
  NODE_ENV: "development",
  // Local development capabilities require an explicit runtime opt-in.
  STELLA_LOCAL_DEV: "1",
  STELLA_API_PORT: String(ports.api),
  STELLA_WEB_PORT: String(ports.web),
  ...(infraOffset > 0 && {
    DATABASE_URL: `postgres://postgres:postgres@localhost:${String(infraPorts.postgres)}/stella`,
    GOTENBERG_URL: `http://localhost:${String(infraPorts.gotenberg)}`,
    REDIS_URL: `redis://localhost:${String(infraPorts.valkey)}`,
    S3_ENDPOINT: `http://localhost:${String(infraPorts.rustfs)}`,
  }),
});

export const createWebEnv = ({
  baseEnv,
  ports,
}: {
  baseEnv: NodeJS.ProcessEnv;
  ports: DevPorts;
}) => ({
  ...baseEnv,
  STELLA_API_PORT: String(ports.api),
  STELLA_WEB_PORT: String(ports.web),
  VITE_API_URL: `http://localhost:${String(ports.api)}`,
  VITE_DESKTOP_BRIDGE_PORT: String(ports.desktopBridge),
});

export const createDesktopEnv = ({
  baseEnv,
  ports,
}: {
  baseEnv: NodeJS.ProcessEnv;
  ports: DevPorts;
}) => ({
  ...baseEnv,
  STELLA_API_PORT: String(ports.api),
  STELLA_DESKTOP_BRIDGE_PORT: String(ports.desktopBridge),
  STELLA_DESKTOP_VIEW_PORT: String(ports.desktopView),
  STELLA_WEB_PORT: String(ports.web),
});

export const shouldAutoOpenBrowser = ({
  ci = process.env["CI"],
  mode,
  noBrowser,
}: {
  ci?: string;
  mode: DevMode;
  noBrowser: boolean;
}) => modeIncludesWeb(mode) && !noBrowser && ci !== "true";

const decodeOutput = (value: Uint8Array) =>
  new TextDecoder().decode(value).trim();

const resolveEnv = (env: NodeJS.ProcessEnv | undefined) => env ?? process.env;

const stripAppEnvKeys = ({
  baseEnv,
  envFilePath,
}: {
  baseEnv: NodeJS.ProcessEnv;
  envFilePath: string;
}) => {
  if (!existsSync(envFilePath)) {
    return { ...baseEnv };
  }

  const envFile = readFileSync(envFilePath, "utf-8");
  const envKeys = new Set<string>();

  for (const line of envFile.split(/\r?\n/u)) {
    const trimmedLine = line.trim();
    if (
      trimmedLine.length === 0 ||
      trimmedLine.startsWith("#") ||
      !trimmedLine.includes("=")
    ) {
      continue;
    }

    const withoutExport = trimmedLine.startsWith("export ")
      ? trimmedLine.slice("export ".length)
      : trimmedLine;
    const [rawKey] = withoutExport.split("=", 1);
    const key = rawKey?.trim();

    if (!key) {
      continue;
    }

    envKeys.add(key);
  }

  return Object.fromEntries(
    Object.entries(baseEnv).filter(([key]) => !envKeys.has(key)),
  );
};

export const loadEnvFile = (envFilePath: string): Record<string, string> => {
  if (!existsSync(envFilePath)) {
    return {};
  }
  const env: Record<string, string> = {};
  const envFile = readFileSync(envFilePath, "utf-8");
  for (const line of envFile.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) {
      continue;
    }
    const withoutExport = trimmed.startsWith("export ")
      ? trimmed.slice("export ".length)
      : trimmed;
    const eqIndex = withoutExport.indexOf("=");
    if (eqIndex === -1) {
      continue;
    }
    const key = withoutExport.slice(0, eqIndex).trim();
    const rawValue = withoutExport.slice(eqIndex + 1).trimStart();
    let quoteChar: string | null = null;
    if (rawValue.startsWith('"')) {
      quoteChar = '"';
    } else if (rawValue.startsWith("'")) {
      quoteChar = "'";
    }
    let endIndex = rawValue.length;
    if (quoteChar !== null) {
      const closingQuote = rawValue.indexOf(quoteChar, 1);
      if (closingQuote !== -1) {
        endIndex = closingQuote + 1;
      }
    } else {
      const hashIndex = rawValue.indexOf("#");
      if (hashIndex !== -1) {
        endIndex = hashIndex;
      }
    }
    let value = rawValue.slice(0, endIndex).trim();
    if (
      quoteChar !== null &&
      value.startsWith(quoteChar) &&
      value.endsWith(quoteChar)
    ) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }

  return env;
};

export const expandEnvMap = (
  env: Record<string, string>,
): Record<string, string> => {
  const expanded = { ...env };
  const cache: Record<string, string> = {};
  const visiting = new Set<string>();

  const resolveKey = (key: string): string => {
    if (cache[key] !== undefined) {
      return cache[key];
    }
    const rawVal = expanded[key] ?? process.env[key];
    if (rawVal === undefined) {
      return "";
    }
    if (visiting.has(key)) {
      return rawVal;
    }
    visiting.add(key);
    const resolved = rawVal
      .replace(
        /(?<!\\)\$(?:\{(?<braced>[^}]+)\}|(?<bare>[a-zA-Z_][a-zA-Z0-9_]*))/gu,
        (_, braced, bare) => {
          const varName = braced || bare;
          return resolveKey(varName);
        },
      )
      .replace(/\\(?<dollar>\$)/gu, "$<dollar>");
    visiting.delete(key);
    cache[key] = resolved;
    return resolved;
  };

  for (const key of Object.keys(expanded)) {
    expanded[key] = resolveKey(key);
  }
  return expanded;
};

const runCommandText = ({
  cmd,
  cwd,
  env,
}: {
  cmd: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
}) => {
  const result = Bun.spawnSync(cmd, {
    cwd,
    env: resolveEnv(env),
    stderr: "pipe",
    stdout: "pipe",
  });

  if (!result.success) {
    const stderr = decodeOutput(result.stderr);
    panic(stderr || `Command failed: ${cmd.join(" ")}`);
  }

  return decodeOutput(result.stdout);
};

const runStep = (step: Step) => {
  console.log(`==> ${step.label}...`);
  const result = Bun.spawnSync(step.cmd, {
    cwd: step.cwd,
    env: resolveEnv(step.env),
    stderr: "inherit",
    stdout: "inherit",
  });

  if (!result.success) {
    panic(`${step.label} failed with exit code ${String(result.exitCode)}.`);
  }
};

const validateApiHealth = (response: Response, bodyText: string) => {
  if (!response.ok) {
    return `expected 200 from /health, received ${String(response.status)}`;
  }

  const payload = readJson(bodyText);
  if (!isRecord(payload) || payload["status"] !== "ok") {
    return "expected JSON body with status=ok";
  }

  return undefined;
};

const validateWebHtml = (response: Response, bodyText: string) => {
  if (!response.ok) {
    return `expected 200 from web root, received ${String(response.status)}`;
  }

  return bodyText.includes(WEB_HTML_MARKER)
    ? undefined
    : `expected HTML marker ${WEB_HTML_MARKER}`;
};

const validateDesktopBridgeHealth =
  (expectedPort: number) => (response: Response, bodyText: string) => {
    if (!response.ok) {
      return `expected 200 from desktop bridge health, received ${String(response.status)}`;
    }

    const payload = readJson(bodyText);
    if (!isRecord(payload) || payload["ok"] !== true) {
      return "expected desktop bridge health payload with ok=true";
    }

    if (payload["bridgePort"] !== expectedPort) {
      return `expected bridgePort=${String(expectedPort)}`;
    }

    return undefined;
  };

// Set by main()'s shutdown handler as soon as a shutdown (Ctrl+C, SIGTERM,
// or a sibling child exiting) starts. waitForHttpReadiness's crash watcher
// checks this so a child killed as part of an intentional shutdown during
// startup is treated as a clean exit, not a crash.
let isShuttingDown = false;

// Thrown when a shutdown interrupts an in-progress startup step (a readiness
// wait, or spawning the next batch of persistent children). main()'s startup
// try/catch treats this as "stop the startup sequence" rather than a crash:
// it does not rethrow to the top-level handler (which would log a crash
// message and call process.exit(1)), and it does not call process.exit
// itself. The signal handler's own in-flight shutdown() call already owns
// tearing down children and exiting the process; this just stops main()
// from racing it by continuing to start more steps.
class DevRunnerShutdownSignalError extends Error {
  constructor() {
    super("Dev runner shutdown requested during startup.");
    this.name = "DevRunnerShutdownSignalError";
  }
}

const isDevRunnerShutdownSignal = (
  error: unknown,
): error is DevRunnerShutdownSignalError =>
  error instanceof DevRunnerShutdownSignalError;

export const stopChildren = async ({
  children,
  wait = async (durationMs) => await Bun.sleep(durationMs),
}: StopChildrenOptions): Promise<readonly string[]> => {
  const pending = new Set(children);
  const allExited = Promise.all(
    children.map(async (runningStep) => {
      // `Bun.Subprocess.exited` resolves with the exit status, including for a
      // process terminated by a signal.
      await runningStep.child.exited;
      pending.delete(runningStep);
    }),
  );

  for (const runningStep of children) {
    runningStep.child.kill();
  }

  const gracefulOutcome = await Promise.race([
    allExited.then(() => "exited" as const),
    wait(CHILD_SHUTDOWN_GRACE_PERIOD_MS).then(() => "timed-out" as const),
  ]);
  if (gracefulOutcome === "exited") {
    return [];
  }

  const forcedSteps = [...pending];
  for (const runningStep of forcedSteps) {
    runningStep.child.kill(FORCE_KILL_SIGNAL);
  }

  // Never let an uncooperative or already-detached child keep the runner open.
  await Promise.race([allExited, wait(CHILD_FORCE_EXIT_TIMEOUT_MS)]);
  return forcedSteps.map(({ label }) => label);
};

const waitForHttpReadiness = async ({
  child,
  label,
  timeoutMs = DEFAULT_HTTP_READY_TIMEOUT_MS,
  url,
  validate,
}: HttpReadinessWaitOptions) => {
  const pollUntilReady = async () => {
    const startedAt = Temporal.Now.instant().epochMilliseconds;
    let lastFailure = "service did not respond yet";

    while (Temporal.Now.instant().epochMilliseconds - startedAt < timeoutMs) {
      try {
        // oxlint-disable-next-line no-network-await-in-loop/no-network-await-in-loop -- readiness poll: each probe observes the service after the previous backoff
        const response = await fetch(url, {
          method: "GET",
          signal: AbortSignal.timeout(DEFAULT_HTTP_PROBE_TIMEOUT_MS),
        });
        const bodyText = await response.text();
        const validationFailure = await validate(response, bodyText);

        if (!validationFailure) {
          return;
        }

        lastFailure = validationFailure;
      } catch (error) {
        lastFailure = error instanceof Error ? error.message : String(error);
      }

      await Bun.sleep(300);
    }

    panic(`Timed out waiting for ${label}: ${lastFailure}.`);
  };

  // Races the HTTP poll against the child's own exit: a child that dies at
  // spawn (bad env var, port conflict, etc.) should fail immediately with
  // its exit code instead of burning the full readiness timeout.
  //
  // `child.exited` keeps resolving long after readiness is decided (e.g. when
  // the runner kills the child during a later, normal shutdown), so the
  // `.then` below must check `settled` first and bail out without acting;
  // otherwise it would fire on every post-readiness exit, including clean
  // ones, after nothing is racing against it anymore.
  //
  // It must also check `isShuttingDown`: a SIGINT/SIGTERM during startup
  // kills every child (including this one) before readiness is settled. That
  // intentional kill must NOT resolve the race as if readiness succeeded
  // (which would let the caller proceed to the next startup step while
  // shutdown is tearing children down) and must NOT be misreported as a
  // crash panic. So it rejects with a distinct shutdown signal instead,
  // which the caller propagates so the startup sequence stops.
  let settled = false;
  const watchForCrash = child.exited.then((exitCode) => {
    if (settled) {
      return "watched-exit-ignored" as const;
    }

    if (isShuttingDown) {
      throw new DevRunnerShutdownSignalError();
    }

    return panic(
      `${label} exited with code ${String(exitCode)} before it became ready.`,
    );
  });

  try {
    await Promise.race([pollUntilReady(), watchForCrash]);
  } finally {
    settled = true;
  }
};

// Readiness checks and their running steps are built in the same mode-gated
// order (see buildPersistentSteps / buildReadinessChecks), so they line up
// positionally; pairing them here is what lets waitForHttpReadiness watch
// the right child for a crash.
const waitForReadinessChecks = async (
  runningSteps: readonly RunningStep[],
  checks: readonly HttpReadinessCheck[],
) => {
  for (const [index, readinessCheck] of checks.entries()) {
    const runningStep =
      runningSteps[index] ??
      panic(
        `No running process found for readiness check "${readinessCheck.label}".`,
      );
    await waitForHttpReadiness({ ...readinessCheck, child: runningStep.child });
  }
};

const spawnPersistentStep = (step: Step): RunningStep => {
  console.log(`==> Starting ${step.label}...`);

  return {
    ...step,
    child: Bun.spawn(step.cmd, {
      cwd: step.cwd,
      env: resolveEnv(step.env),
      stderr: "inherit",
      stdin: "inherit",
      stdout: "inherit",
    }),
  };
};

const createGitContext = (cwd: string): GitContext => {
  const currentRoot = runCommandText({
    cmd: [resolveCommandPath("git"), "rev-parse", "--show-toplevel"],
    cwd,
  });
  const commonGitDirOutput = runCommandText({
    cmd: [resolveCommandPath("git"), "rev-parse", "--git-common-dir"],
    cwd,
  });
  const commonGitDir = resolveMaybeRelativePath(
    currentRoot,
    commonGitDirOutput,
  );
  const isWorktree = isWorktreeCheckout(currentRoot);

  return {
    // Symlinked parents (macOS /tmp, linked worktree roots) would otherwise
    // hash the same checkout to different offsets depending on the cwd it was
    // reached through.
    canonicalRoot: realpathSync(currentRoot),
    commonGitDir,
    currentRoot,
    isWorktree,
    mainRoot: isWorktree
      ? resolveMainRootFromCommonDir(commonGitDir)
      : currentRoot,
  };
};

export const buildPreparationSteps = ({
  infraOffset,
  infraPorts,
  mode,
  ports,
  rootDir,
  skipDbPush,
  skipInstall,
}: {
  infraOffset: number;
  infraPorts: InfraPorts;
  mode: DevMode;
  ports: DevPorts;
  rootDir: string;
  skipDbPush: boolean;
  skipInstall: boolean;
}) => {
  const steps: Step[] = [];

  if (!skipInstall) {
    steps.push({
      cmd: [resolveCommandPath("bun"), "ci"],
      cwd: rootDir,
      label: "Installing dependencies with bun ci",
    });
  }

  if (!skipDbPush && modeIncludesApi(mode)) {
    const apiBaseEnv = stripAppEnvKeys({
      baseEnv: process.env,
      envFilePath: path.resolve(rootDir, "apps/api/.env"),
    });
    steps.push({
      cmd: [resolveCommandPath("bun"), "run", "db:migrate"],
      cwd: path.resolve(rootDir, "apps/api"),
      env: {
        ...expandEnvMap(loadEnvFile(path.resolve(rootDir, "apps/api/.env"))),
        ...createApiEnv({
          baseEnv: apiBaseEnv,
          infraOffset,
          infraPorts,
          ports,
        }),
      },
      label: "Applying database migrations",
    });
  }

  return steps;
};

export const buildPersistentSteps = ({
  infraOffset,
  infraPorts,
  mode,
  ports,
  rootDir,
}: {
  infraOffset: number;
  infraPorts: InfraPorts;
  mode: DevMode;
  ports: DevPorts;
  rootDir: string;
}): PersistentSteps => {
  const apiBaseEnv = stripAppEnvKeys({
    baseEnv: process.env,
    envFilePath: path.resolve(rootDir, "apps/api/.env"),
  });
  const webBaseEnv = stripAppEnvKeys({
    baseEnv: process.env,
    envFilePath: path.resolve(rootDir, "apps/web/.env"),
  });
  const desktopBaseEnv = stripAppEnvKeys({
    baseEnv: process.env,
    envFilePath: path.resolve(rootDir, "apps/desktop/.env"),
  });
  const apiEnv = {
    ...expandEnvMap(loadEnvFile(path.resolve(rootDir, "apps/api/.env"))),
    ...createApiEnv({
      baseEnv: apiBaseEnv,
      infraOffset,
      infraPorts,
      ports,
    }),
  };
  const webEnv = {
    ...expandEnvMap(loadEnvFile(path.resolve(rootDir, "apps/web/.env"))),
    ...createWebEnv({
      baseEnv: webBaseEnv,
      ports,
    }),
  };
  const desktopEnv = {
    ...expandEnvMap(loadEnvFile(path.resolve(rootDir, "apps/desktop/.env"))),
    ...createDesktopEnv({
      baseEnv: desktopBaseEnv,
      ports,
    }),
  };
  const primary: Step[] = [];
  const secondary: Step[] = [];

  if (modeIncludesApi(mode)) {
    primary.push({
      cmd: [
        resolveCommandPath("bun"),
        "--no-clear-screen",
        "--no-env-file",
        "--preload",
        "./src/dev/register-mock-ai.ts",
        "--watch",
        "src/server.ts",
      ],
      cwd: path.resolve(rootDir, "apps/api"),
      env: apiEnv,
      label: "API server",
    });
  }

  if (modeIncludesWeb(mode)) {
    primary.push({
      cmd: [
        resolveCommandPath("bun"),
        "run",
        "dev",
        "--",
        "--port",
        String(ports.web),
        "--host",
        "localhost",
        "--strictPort",
      ],
      cwd: path.resolve(rootDir, "apps/web"),
      env: webEnv,
      label: "Web server",
    });
  }

  // Uploads only become searchable, extractable, and readable by AI once the
  // document-processing worker drains their runs; without it every upload
  // stays queued forever. It has no HTTP surface, so it goes after the
  // readiness-checked steps: checks pair with steps by position.
  if (modeIncludesApi(mode)) {
    primary.push({
      cmd: [
        resolveCommandPath("bun"),
        "--no-clear-screen",
        "--no-env-file",
        "--preload",
        "./src/dev/register-mock-ai.ts",
        "--watch",
        "src/scripts/document-processing-worker.ts",
      ],
      cwd: path.resolve(rootDir, "apps/api"),
      env: apiEnv,
      label: "Document processing worker",
    });
  }

  if (modeIncludesDesktop(mode)) {
    // Tauri's beforeDevCommand spawns dev:view itself; we override devUrl
    // so Tauri waits for the runner-allocated port instead of the static
    // 5177 baked into tauri.conf.json.
    const tauriConfigOverride = JSON.stringify({
      build: { devUrl: desktopViewUrlForPort(ports.desktopView) },
    });
    secondary.push({
      cmd: [
        resolveCommandPath("bun"),
        "run",
        "dev",
        "--",
        "-c",
        tauriConfigOverride,
      ],
      cwd: path.resolve(rootDir, "apps/desktop"),
      env: desktopEnv,
      label: "Desktop app",
    });
  }

  return {
    primary,
    secondary,
  };
};

const buildReadinessChecks = ({
  mode,
  ports,
}: {
  mode: DevMode;
  ports: DevPorts;
}): ReadinessChecks => {
  const primary: HttpReadinessCheck[] = [];
  const secondary: HttpReadinessCheck[] = [];

  if (modeIncludesApi(mode)) {
    primary.push({
      label: "API server",
      url: `${apiUrlForPort(ports.api)}/health`,
      validate: validateApiHealth,
    });
  }

  if (modeIncludesWeb(mode)) {
    primary.push({
      label: "Web server",
      url: webUrlForPort(ports.web),
      validate: validateWebHtml,
    });
  }

  if (modeIncludesDesktop(mode)) {
    secondary.push({
      label: "Desktop bridge",
      // Cold Rust compile of the Tauri crate routinely takes several
      // minutes; the bridge only binds after the build finishes.
      timeoutMs: 900_000,
      url: `${desktopBridgeUrlForPort(ports.desktopBridge)}/health`,
      validate: validateDesktopBridgeHealth(ports.desktopBridge),
    });
  }

  return {
    primary,
    secondary,
  };
};

const browserCommandForUrl = (url: string) => {
  if (process.platform === "darwin") {
    return [resolveCommandPath("open"), url];
  }

  if (process.platform === "linux") {
    return [resolveCommandPath("xdg-open"), url];
  }

  if (process.platform === "win32") {
    return ["cmd", "/c", "start", "", url];
  }

  return undefined;
};

const openBrowser = (url: string) => {
  const command = browserCommandForUrl(url);
  if (!command) {
    return false;
  }

  try {
    Bun.spawn(command, {
      stderr: "ignore",
      stdout: "ignore",
      timeout: DEFAULT_OPEN_BROWSER_TIMEOUT_MS,
    });
    return true;
  } catch {
    return false;
  }
};

const printSummary = ({
  browserWillOpen,
  infraOffset,
  infraPorts,
  preparedEnvFiles,
  mode,
  offset,
  offsetSource,
  ports,
  rootDir,
}: {
  browserWillOpen: boolean;
  infraOffset: number;
  infraPorts: InfraPorts;
  preparedEnvFiles: number;
  mode: DevMode;
  offset: number;
  offsetSource: string;
  ports: DevPorts;
  rootDir: string;
}) => {
  console.log("");
  console.log("Stella dev runner");
  console.log(`  mode: ${mode}`);
  console.log(`  root: ${rootDir}`);
  console.log(`  offset: ${String(offset)} (${offsetSource})`);
  if (infraOffset > 0) {
    console.log(`  infra offset: ${String(infraOffset)}`);
  }
  console.log(`  env files prepared: ${String(preparedEnvFiles)}`);
  if (modeIncludesWeb(mode)) {
    console.log(`  web: ${webUrlForPort(ports.web)}`);
    console.log(
      `  browser: ${browserWillOpen ? "auto-open enabled" : "disabled"}`,
    );
  }
  if (modeIncludesApi(mode)) {
    console.log(`  api: ${apiUrlForPort(ports.api)}`);
    console.log(`  postgres: localhost:${String(infraPorts.postgres)}`);
    console.log(`  valkey: localhost:${String(infraPorts.valkey)}`);
    console.log(`  rustfs: localhost:${String(infraPorts.rustfs)}`);
    console.log(`  gotenberg: localhost:${String(infraPorts.gotenberg)}`);
  }
  if (modeIncludesDesktop(mode)) {
    console.log(`  desktop view: ${desktopViewUrlForPort(ports.desktopView)}`);
    console.log(
      `  desktop bridge: ${desktopBridgeUrlForPort(ports.desktopBridge)}`,
    );
  }
  console.log("");
};

const printDryRun = ({
  browserWillOpen,
  infraOffset,
  infraPorts,
  preparedEnvFiles,
  mode,
  offset,
  offsetSource,
  persistentSteps,
  ports,
  preparationSteps,
  rootDir,
}: {
  browserWillOpen: boolean;
  infraOffset: number;
  infraPorts: InfraPorts;
  preparedEnvFiles: number;
  mode: DevMode;
  offset: number;
  offsetSource: string;
  persistentSteps: PersistentSteps;
  ports: DevPorts;
  preparationSteps: Step[];
  rootDir: string;
}) => {
  printSummary({
    browserWillOpen,
    infraOffset,
    infraPorts,
    preparedEnvFiles,
    mode,
    offset,
    offsetSource,
    ports,
    rootDir,
  });
  console.log("Preparation steps:");
  for (const step of preparationSteps) {
    console.log(`  - ${step.cmd.join(" ")}`);
  }
  console.log("Persistent steps:");
  for (const step of [
    ...persistentSteps.primary,
    ...persistentSteps.secondary,
  ]) {
    console.log(`  - ${step.cmd.join(" ")}`);
  }
};

const main = async () => {
  const config = readDevRunnerConfig();
  if (Result.isError(config)) {
    panic(config.error.message);
  }
  const parsedArgs = config.value;
  const gitContext = createGitContext(process.cwd());
  const preparedEnvFiles = ensureWorktreeEnvLinks({
    currentRoot: gitContext.currentRoot,
    isWorktree: gitContext.isWorktree,
    mainRoot: gitContext.mainRoot,
  });

  const { devInstance, infraOffset, mode, portOffset } = parsedArgs;
  const infraPorts = infraPortsForOffset(infraOffset);
  const dockerProject = dockerProjectName({
    infraOffset,
    isWorktree: gitContext.isWorktree,
    worktreePath: gitContext.canonicalRoot,
  });
  const composeFile = path.resolve(gitContext.mainRoot, "docker-compose.yml");
  const managesDocker = !parsedArgs.dryRun && modeIncludesApi(mode);
  const children: RunningStep[] = [];
  let cleanupPromise: Promise<boolean> | undefined;
  let ownsDockerProject = false;

  const cleanup = async () => {
    if (cleanupPromise) {
      return cleanupPromise;
    }

    isShuttingDown = true;
    cleanupPromise = (async () => {
      const forcedChildren = await stopChildren({ children });
      if (forcedChildren.length > 0) {
        console.warn(
          `Forced ${forcedChildren.join(", ")} to exit after the graceful shutdown deadline.`,
        );
      }

      if (!ownsDockerProject) {
        return true;
      }

      const stopped = Result.try({
        try: () =>
          stopDockerProject({
            composeFile,
            dockerProject,
            rootDir: gitContext.mainRoot,
          }),
        catch: (cause) =>
          cause instanceof Error ? cause.message : String(cause),
      });
      if (stopped.isErr()) {
        console.error(
          `Docker cleanup failed for ${dockerProject}: ${stopped.error}`,
        );
      }
      return stopped.isOk();
    })();

    return cleanupPromise;
  };

  const shutdown = async (exitCode: number) => {
    const cleanupSucceeded = await cleanup();
    process.exit(cleanupSucceeded ? exitCode : 1);
  };

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      shutdown(0).catch((error: unknown) => {
        console.error("Dev runner shutdown failed:", error);
        process.exit(1);
      });
    });
  }

  const initialOffset = resolveOffset({
    devInstance,
    isWorktree: gitContext.isWorktree,
    portOffset,
    worktreePath: gitContext.canonicalRoot,
  });
  const resolvedOffset = await findFirstAvailableOffset({
    mode,
    startOffset: initialOffset.offset,
  });
  const ports = portsForOffset(resolvedOffset);
  const offsetSource =
    resolvedOffset === initialOffset.offset
      ? initialOffset.source
      : `${initialOffset.source}; adjusted for free ports`;
  const preparationSteps = buildPreparationSteps({
    infraOffset,
    infraPorts,
    mode,
    ports,
    rootDir: gitContext.currentRoot,
    skipDbPush: parsedArgs.skipDbPush,
    skipInstall: parsedArgs.skipInstall,
  });
  const persistentSteps = buildPersistentSteps({
    infraOffset,
    infraPorts,
    mode,
    ports,
    rootDir: gitContext.currentRoot,
  });
  const readinessChecks = buildReadinessChecks({
    mode,
    ports,
  });
  const browserWillOpen = shouldAutoOpenBrowser({
    mode,
    noBrowser: parsedArgs.noBrowser,
  });

  if (parsedArgs.dryRun) {
    printDryRun({
      browserWillOpen,
      infraOffset,
      infraPorts,
      preparedEnvFiles,
      mode,
      offset: resolvedOffset,
      offsetSource,
      persistentSteps,
      ports,
      preparationSteps,
      rootDir: gitContext.currentRoot,
    });
    return;
  }

  const startSteps = (steps: readonly Step[]): RunningStep[] => {
    if (isShuttingDown) {
      throw new DevRunnerShutdownSignalError();
    }

    // Register each child immediately so cleanup covers partial startup.
    return steps.map((step) => {
      const runningStep = spawnPersistentStep(step);
      children.push(runningStep);
      return runningStep;
    });
  };

  try {
    if (managesDocker) {
      console.log("==> Checking Docker engine...");
      runStep({
        cmd: [resolveCommandPath("docker"), "ps"],
        cwd: gitContext.currentRoot,
        label: "Verifying Docker engine health",
      });
      const ownershipOutput = readDockerComposeProjectOwnershipOutput(
        gitContext.mainRoot,
      );
      if (
        hasConflictingDockerOwner({
          dockerProject,
          initialOffset: initialOffset.offset,
          output: ownershipOutput,
          resolvedOffset,
        })
      ) {
        panic(
          `Docker project ${dockerProject} already belongs to another dev runner in this worktree. Stop that runner before starting another API process.`,
        );
      }
      ownsDockerProject =
        parseDockerProjectOwnership(ownershipOutput).has(dockerProject);
      removeProjectsForDeletedWorktrees({
        composeFile,
        ownershipOutput,
        rootDir: gitContext.mainRoot,
      });
      const legacyDockerProject = legacyDockerProjectName(infraOffset);
      if (
        legacyDockerProject !== dockerProject &&
        dockerProjectBelongsToWorktree({
          dockerProject: legacyDockerProject,
          output: ownershipOutput,
          worktreePaths: [gitContext.currentRoot, gitContext.canonicalRoot],
        })
      ) {
        stopDockerProject({
          composeFile,
          dockerProject: legacyDockerProject,
          rootDir: gitContext.mainRoot,
        });
      }
      await ensureDockerServices({
        dockerProject,
        infraPorts,
        markStarted: () => {
          ownsDockerProject = true;
        },
        rootDir: gitContext.currentRoot,
      });
    }

    for (const step of preparationSteps) {
      try {
        runStep(step);
      } catch (error) {
        if (step.cmd.at(1) === "ci") {
          console.error(
            "ERROR: bun ci failed; the lockfile is out of sync. Run `bun install` intentionally, review the diff, then commit bun.lock.",
          );
        }
        throw error;
      }
    }

    const primaryChildren = startSteps(persistentSteps.primary);
    await waitForReadinessChecks(primaryChildren, readinessChecks.primary);

    const secondaryChildren = startSteps(persistentSteps.secondary);
    await waitForReadinessChecks(secondaryChildren, readinessChecks.secondary);

    if (browserWillOpen && !openBrowser(webUrlForPort(ports.web))) {
      console.warn(
        "Could not auto-open the browser; open the printed web URL manually.",
      );
    }

    printSummary({
      browserWillOpen,
      infraOffset,
      infraPorts,
      preparedEnvFiles,
      mode,
      offset: resolvedOffset,
      offsetSource,
      ports,
      rootDir: gitContext.currentRoot,
    });

    const firstExit = await Promise.race(
      children.map(async ({ child, label }) => ({
        exitCode: await child.exited,
        label,
      })),
    );
    console.error(
      `${firstExit.label} exited with code ${String(firstExit.exitCode)}; shutting down the dev runner.`,
    );
    await shutdown(firstExit.exitCode);
  } catch (error) {
    // The signal handler owns cleanup and the exit code for interrupted startup.
    if (isDevRunnerShutdownSignal(error)) {
      return;
    }
    await cleanup();
    throw error;
  }
};

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
