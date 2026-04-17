#!/usr/bin/env bun
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
} from "node:fs";
import { createServer, Socket } from "node:net";
import {
  basename,
  dirname,
  isAbsolute,
  resolve as pathResolve,
} from "node:path";

const DEV_MODES = ["dev", "dev:web", "dev:api", "dev:desktop"] as const;
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
const DEFAULT_PORTS = {
  api: 3001,
  desktopBridge: 45_901,
  desktopView: 5177,
  web: 3000,
} as const;
const DEFAULT_HTTP_PROBE_TIMEOUT_MS = 1500;
const DEFAULT_HTTP_READY_TIMEOUT_MS = 30_000;
const DEFAULT_OPEN_BROWSER_TIMEOUT_MS = 5000;
const DEFAULT_INFRA_PORTS = {
  gotenberg: 3003,
  minio: 9000,
  minioConsole: 9001,
  postgres: 5432,
  valkey: 6379,
} as const;
const SHARED_DOCKER_PROJECT_BASE = "stella-dev";
const MAX_HASH_OFFSET = 400;
const MAX_PORT = 65_535;
const MAX_INFRA_OFFSET =
  MAX_PORT - Math.max(...Object.values(DEFAULT_INFRA_PORTS));
const MAX_PORT_OFFSET = MAX_PORT - Math.max(...Object.values(DEFAULT_PORTS));
const PORT_SEARCH_LIMIT = 2000;
const WEB_HTML_MARKER = 'id="app"';
const DESKTOP_HTML_MARKERS = [
  "<title>stella desktop</title>",
  'id="root"',
] as const;

export type DevMode = (typeof DEV_MODES)[number];

export type InfraPorts = {
  gotenberg: number;
  minio: number;
  minioConsole: number;
  postgres: number;
  valkey: number;
};

type ParsedArgs = {
  devInstance: string | undefined;
  dryRun: boolean;
  infraOffset: number | undefined;
  mode: DevMode;
  noBrowser: boolean;
  portOffset: number | undefined;
  skipDbPush: boolean;
  skipInstall: boolean;
};

export type OffsetConfig = {
  branchName: string | undefined;
  devInstance: string | undefined;
  isWorktree: boolean;
  portOffset: number | undefined;
  worktreeName: string | undefined;
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
  branchName: string | undefined;
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

type HttpReadinessCheck = {
  label: string;
  timeoutMs?: number;
  url: string;
  validate: (
    response: Response,
    bodyText: string,
  ) => Promise<string | undefined> | string | undefined;
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

const isDevMode = (value: string): value is DevMode =>
  DEV_MODES.some((mode) => mode === value);

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

const normalizeCommandOutput = (output: string) => {
  const trimmed = output.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

const resolveCommandPath = (command: string) => Bun.which(command) ?? command;

const resolveMaybeRelativePath = (cwd: string, value: string) =>
  isAbsolute(value) ? value : pathResolve(cwd, value);

const validateOffset = (offset: number, source: string) => {
  if (!Number.isInteger(offset) || offset < 0 || offset > MAX_PORT_OFFSET) {
    throw new Error(
      `${source} must be an integer between 0 and ${String(MAX_PORT_OFFSET)}`,
    );
  }
};

export const parseArgs = (args: string[]): ParsedArgs => {
  let mode: DevMode = "dev";
  let portOffset: number | undefined;
  let infraOffset: number | undefined;
  let devInstance: string | undefined;
  let skipInstall = false;
  let skipDbPush = false;
  let dryRun = false;
  let noBrowser = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg) {
      continue;
    }

    if (isDevMode(arg)) {
      mode = arg;
      continue;
    }

    if (arg === "--skip-install") {
      skipInstall = true;
      continue;
    }

    if (arg === "--skip-db-push") {
      skipDbPush = true;
      continue;
    }

    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }

    if (arg === "--no-browser") {
      noBrowser = true;
      continue;
    }

    if (arg === "--port-offset") {
      const value = args[i + 1];
      if (!value) {
        throw new Error("--port-offset requires a value");
      }
      portOffset = Number.parseInt(value, 10);
      i++;
      continue;
    }

    if (arg === "--dev-instance") {
      const value = args[i + 1];
      if (!value) {
        throw new Error("--dev-instance requires a value");
      }
      devInstance = value;
      i++;
      continue;
    }

    if (arg === "--infra-offset") {
      const value = args[i + 1];
      if (!value) {
        throw new Error("--infra-offset requires a value");
      }
      infraOffset = Number.parseInt(value, 10);
      i++;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return {
    devInstance,
    dryRun,
    infraOffset,
    mode,
    noBrowser,
    portOffset,
    skipDbPush,
    skipInstall,
  };
};

export const resolveOffset = ({
  branchName,
  devInstance,
  isWorktree,
  portOffset,
  worktreeName,
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
    if (/^\d+$/.test(configuredInstance)) {
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

  const seed = branchName?.trim() || worktreeName?.trim();
  if (!seed) {
    return {
      offset: 1,
      source: "fallback worktree offset",
    };
  }

  return {
    offset: (hashSeed(seed) % MAX_HASH_OFFSET) + 1,
    source: `hashed worktree=${seed}`,
  };
};

export const infraPortsForOffset = (offset: number): InfraPorts => ({
  gotenberg: DEFAULT_INFRA_PORTS.gotenberg + offset,
  minio: DEFAULT_INFRA_PORTS.minio + offset,
  minioConsole: DEFAULT_INFRA_PORTS.minioConsole + offset,
  postgres: DEFAULT_INFRA_PORTS.postgres + offset,
  valkey: DEFAULT_INFRA_PORTS.valkey + offset,
});

const dockerProjectName = (infraOffset: number) =>
  infraOffset === 0
    ? SHARED_DOCKER_PROJECT_BASE
    : `${SHARED_DOCKER_PROJECT_BASE}-${String(infraOffset)}`;

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

const connectToPort = async ({
  host = "127.0.0.1",
  port,
  timeoutMs = 750,
}: {
  host?: string;
  port: number;
  timeoutMs?: number;
}) =>
  await new Promise<boolean>((resolve) => {
    const socket = new Socket();

    const finish = (result: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(result);
    };

    socket.once("connect", () => {
      finish(true);
    });

    socket.once("error", () => {
      finish(false);
    });

    socket.setTimeout(timeoutMs, () => {
      finish(false);
    });

    socket.connect(port, host);
  });

const checkHttpOk = async (url: string) => {
  try {
    const response = await fetch(url, {
      method: "GET",
      signal: AbortSignal.timeout(DEFAULT_HTTP_PROBE_TIMEOUT_MS),
    });
    return response.ok;
  } catch {
    return false;
  }
};

const areSharedDockerServicesHealthy = async (infraPorts: InfraPorts) => {
  const healthChecks = await Promise.all([
    connectToPort({ port: infraPorts.postgres }),
    connectToPort({ port: infraPorts.valkey }),
    checkHttpOk(
      `http://127.0.0.1:${String(infraPorts.minio)}/minio/health/live`,
    ),
    checkHttpOk(`http://127.0.0.1:${String(infraPorts.gotenberg)}/health`),
  ]);

  return healthChecks.every(Boolean);
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
  infraPorts.minio,
  infraPorts.minioConsole,
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

const dockerComposeEnv = (infraPorts: InfraPorts) => ({
  ...process.env,
  STELLA_GOTENBERG_HOST_PORT: String(infraPorts.gotenberg),
  STELLA_MINIO_CONSOLE_PORT: String(infraPorts.minioConsole),
  STELLA_MINIO_HOST_PORT: String(infraPorts.minio),
  STELLA_PG_HOST_PORT: String(infraPorts.postgres),
  STELLA_VALKEY_HOST_PORT: String(infraPorts.valkey),
});

const ensureDockerServices = async ({
  infraOffset,
  infraPorts,
  rootDir,
}: {
  infraOffset: number;
  infraPorts: InfraPorts;
  rootDir: string;
}) => {
  if (await areSharedDockerServicesHealthy(infraPorts)) {
    console.log("==> Reusing healthy shared Docker services...");
    return;
  }

  if (!(await areSharedDockerPortsFree(infraPorts))) {
    throw new Error(
      `Shared Docker ports (${sharedInfraPortList(infraPorts).join(", ")}) are already allocated, but the shared dev services did not pass health checks. Stop the conflicting stack, or use --infra-offset to shift Stella's infra ports.`,
    );
  }

  runStep({
    cmd: [
      resolveCommandPath("docker"),
      "compose",
      "--project-name",
      dockerProjectName(infraOffset),
      "--profile",
      "dev",
      "up",
      "-d",
      "--wait",
      "--wait-timeout",
      "30",
    ],
    cwd: rootDir,
    env: dockerComposeEnv(infraPorts),
    label: "Starting Docker services",
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

  throw new Error(
    `Could not find a free port offset for ${mode} after ${String(PORT_SEARCH_LIMIT)} attempts.`,
  );
};

export const isWorktreeCheckout = (rootDir: string) => {
  const gitPath = pathResolve(rootDir, ".git");
  return existsSync(gitPath) && lstatSync(gitPath).isFile();
};

export const resolveMainRootFromCommonDir = (commonGitDir: string) =>
  pathResolve(commonGitDir, "..");

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
    const targetPath = pathResolve(currentRoot, spec.path);
    if (existsSync(targetPath)) {
      continue;
    }

    const mainEnvPath = pathResolve(mainRoot, spec.path);
    if (isWorktree && existsSync(mainEnvPath)) {
      mkdirSync(dirname(targetPath), { recursive: true });
      symlinkSync(mainEnvPath, targetPath);
      preparedFiles++;
      continue;
    }

    const examplePath = pathResolve(currentRoot, spec.example);
    if (!existsSync(examplePath)) {
      continue;
    }

    mkdirSync(dirname(targetPath), { recursive: true });
    copyFileSync(examplePath, targetPath);
    preparedFiles++;
  }

  return preparedFiles;
};

const apiUrlForPort = (port: number) => `http://localhost:${String(port)}`;
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
  BETTER_AUTH_URL: apiUrlForPort(ports.api),
  FRONTEND_URL: webUrlForPort(ports.web),
  STELLA_API_PORT: String(ports.api),
  STELLA_WEB_PORT: String(ports.web),
  ...(infraOffset > 0 && {
    DATABASE_URL: `postgres://postgres:postgres@localhost:${String(infraPorts.postgres)}/stella`,
    GOTENBERG_URL: `http://localhost:${String(infraPorts.gotenberg)}`,
    REDIS_URL: `redis://localhost:${String(infraPorts.valkey)}`,
    S3_ENDPOINT: `http://localhost:${String(infraPorts.minio)}`,
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
  VITE_API_URL: apiUrlForPort(ports.api),
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
  ci = process.env.CI,
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
    throw new Error(stderr || `Command failed: ${cmd.join(" ")}`);
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
    throw new Error(
      `${step.label} failed with exit code ${String(result.exitCode ?? 1)}.`,
    );
  }
};

const readJson = (bodyText: string): unknown => {
  try {
    return JSON.parse(bodyText) as unknown;
  } catch {
    return null;
  }
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const validateApiHealth = (response: Response, bodyText: string) => {
  if (!response.ok) {
    return `expected 200 from /health, received ${String(response.status)}`;
  }

  const payload = readJson(bodyText);
  if (!isRecord(payload) || payload.status !== "ok") {
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

const validateDesktopViewHtml = (response: Response, bodyText: string) => {
  if (!response.ok) {
    return `expected 200 from desktop view root, received ${String(response.status)}`;
  }

  return DESKTOP_HTML_MARKERS.every((marker) => bodyText.includes(marker))
    ? undefined
    : `expected desktop HTML markers ${DESKTOP_HTML_MARKERS.join(", ")}`;
};

const validateDesktopBridgeHealth =
  (expectedPort: number) => (response: Response, bodyText: string) => {
    if (!response.ok) {
      return `expected 200 from desktop bridge health, received ${String(response.status)}`;
    }

    const payload = readJson(bodyText);
    if (!isRecord(payload) || payload.ok !== true) {
      return "expected desktop bridge health payload with ok=true";
    }

    if (payload.bridgePort !== expectedPort) {
      return `expected bridgePort=${String(expectedPort)}`;
    }

    return undefined;
  };

const waitForHttpReadiness = async ({
  label,
  timeoutMs = DEFAULT_HTTP_READY_TIMEOUT_MS,
  url,
  validate,
}: HttpReadinessCheck) => {
  const startedAt = Date.now();
  let lastFailure = "service did not respond yet";

  while (Date.now() - startedAt < timeoutMs) {
    try {
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

  throw new Error(`Timed out waiting for ${label}: ${lastFailure}.`);
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
  const branchName = normalizeCommandOutput(
    runCommandText({
      cmd: [resolveCommandPath("git"), "branch", "--show-current"],
      cwd,
    }),
  );
  const commonGitDir = resolveMaybeRelativePath(
    currentRoot,
    commonGitDirOutput,
  );
  const isWorktree = isWorktreeCheckout(currentRoot);

  return {
    branchName,
    commonGitDir,
    currentRoot,
    isWorktree,
    mainRoot: isWorktree
      ? resolveMainRootFromCommonDir(commonGitDir)
      : currentRoot,
  };
};

const buildPreparationSteps = ({
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
      envFilePath: pathResolve(rootDir, "apps/api/.env"),
    });
    steps.push({
      cmd: [resolveCommandPath("bun"), "run", "db:push"],
      cwd: pathResolve(rootDir, "apps/api"),
      env: createApiEnv({
        baseEnv: apiBaseEnv,
        infraOffset,
        infraPorts,
        ports,
      }),
      label: "Pushing database schema",
    });
  }

  return steps;
};

const buildPersistentSteps = ({
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
    envFilePath: pathResolve(rootDir, "apps/api/.env"),
  });
  const webBaseEnv = stripAppEnvKeys({
    baseEnv: process.env,
    envFilePath: pathResolve(rootDir, "apps/web/.env"),
  });
  const desktopBaseEnv = stripAppEnvKeys({
    baseEnv: process.env,
    envFilePath: pathResolve(rootDir, "apps/desktop/.env"),
  });
  const apiEnv = createApiEnv({
    baseEnv: apiBaseEnv,
    infraOffset,
    infraPorts,
    ports,
  });
  const webEnv = createWebEnv({
    baseEnv: webBaseEnv,
    ports,
  });
  const desktopEnv = createDesktopEnv({
    baseEnv: desktopBaseEnv,
    ports,
  });
  const primary: Step[] = [];
  const secondary: Step[] = [];

  if (modeIncludesApi(mode)) {
    primary.push({
      cmd: [resolveCommandPath("bun"), "--watch", "src/index.ts"],
      cwd: pathResolve(rootDir, "apps/api"),
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
        "--strictPort",
      ],
      cwd: pathResolve(rootDir, "apps/web"),
      env: webEnv,
      label: "Web server",
    });
  }

  if (modeIncludesDesktop(mode)) {
    primary.push({
      cmd: [resolveCommandPath("bun"), "run", "dev:view"],
      cwd: pathResolve(rootDir, "apps/desktop"),
      env: desktopEnv,
      label: "Desktop view server",
    });
    secondary.push({
      cmd: [resolveCommandPath("bun"), "run", "dev:app"],
      cwd: pathResolve(rootDir, "apps/desktop"),
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
    primary.push({
      label: "Desktop view server",
      url: desktopViewUrlForPort(ports.desktopView),
      validate: validateDesktopViewHtml,
    });
    secondary.push({
      label: "Desktop bridge",
      timeoutMs: 60_000,
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
    const child = Bun.spawn(command, {
      stderr: "ignore",
      stdout: "ignore",
    });

    const timeout = setTimeout(() => {
      child.kill();
    }, DEFAULT_OPEN_BROWSER_TIMEOUT_MS);
    timeout.unref();

    void child.exited.finally(() => {
      clearTimeout(timeout);
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
    console.log(`  minio: localhost:${String(infraPorts.minio)}`);
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
  const parsedArgs = parseArgs(process.argv.slice(2));
  const gitContext = createGitContext(process.cwd());
  const preparedEnvFiles = ensureWorktreeEnvLinks({
    currentRoot: gitContext.currentRoot,
    isWorktree: gitContext.isWorktree,
    mainRoot: gitContext.mainRoot,
  });

  const infraOffset =
    parsedArgs.infraOffset ??
    (process.env.STELLA_INFRA_OFFSET
      ? Number.parseInt(process.env.STELLA_INFRA_OFFSET, 10)
      : 0);
  if (
    !Number.isInteger(infraOffset) ||
    infraOffset < 0 ||
    infraOffset > MAX_INFRA_OFFSET
  ) {
    throw new Error(
      `STELLA_INFRA_OFFSET must be an integer between 0 and ${String(MAX_INFRA_OFFSET)}`,
    );
  }
  const infraPorts = infraPortsForOffset(infraOffset);

  if (!parsedArgs.dryRun && modeIncludesApi(parsedArgs.mode)) {
    console.log("==> Checking Docker engine...");
    runStep({
      cmd: [resolveCommandPath("docker"), "ps"],
      cwd: gitContext.currentRoot,
      label: "Verifying Docker engine health",
    });
    await ensureDockerServices({
      infraOffset,
      infraPorts,
      rootDir: gitContext.currentRoot,
    });
  }

  const initialOffset = resolveOffset({
    branchName: gitContext.branchName,
    devInstance: parsedArgs.devInstance ?? process.env.STELLA_DEV_INSTANCE,
    isWorktree: gitContext.isWorktree,
    portOffset:
      parsedArgs.portOffset ??
      (process.env.STELLA_PORT_OFFSET
        ? Number.parseInt(process.env.STELLA_PORT_OFFSET, 10)
        : undefined),
    worktreeName: basename(gitContext.currentRoot),
  });
  const resolvedOffset = await findFirstAvailableOffset({
    mode: parsedArgs.mode,
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
    mode: parsedArgs.mode,
    ports,
    rootDir: gitContext.currentRoot,
    skipDbPush: parsedArgs.skipDbPush,
    skipInstall: parsedArgs.skipInstall,
  });
  const persistentSteps = buildPersistentSteps({
    infraOffset,
    infraPorts,
    mode: parsedArgs.mode,
    ports,
    rootDir: gitContext.currentRoot,
  });
  const readinessChecks = buildReadinessChecks({
    mode: parsedArgs.mode,
    ports,
  });
  const browserWillOpen = shouldAutoOpenBrowser({
    mode: parsedArgs.mode,
    noBrowser: parsedArgs.noBrowser,
  });

  if (parsedArgs.dryRun) {
    printDryRun({
      browserWillOpen,
      infraOffset,
      infraPorts,
      preparedEnvFiles,
      mode: parsedArgs.mode,
      offset: resolvedOffset,
      offsetSource,
      persistentSteps,
      ports,
      preparationSteps,
      rootDir: gitContext.currentRoot,
    });
    return;
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

  const children: RunningStep[] = [];
  let shuttingDown = false;

  const stopChildren = async () => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;

    for (const runningStep of children) {
      runningStep.child.kill();
    }

    await Promise.all(
      children.map(async ({ child }) => await child.exited.catch(() => 1)),
    );
  };

  const shutdown = async (exitCode: number) => {
    await stopChildren();
    process.exit(exitCode);
  };

  const startSteps = (steps: Step[]) => {
    for (const step of steps) {
      children.push(spawnPersistentStep(step));
    }
  };

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      void shutdown(0);
    });
  }

  try {
    startSteps(persistentSteps.primary);

    for (const readinessCheck of readinessChecks.primary) {
      await waitForHttpReadiness(readinessCheck);
    }

    startSteps(persistentSteps.secondary);

    for (const readinessCheck of readinessChecks.secondary) {
      await waitForHttpReadiness(readinessCheck);
    }

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
      mode: parsedArgs.mode,
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
    await stopChildren();
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
