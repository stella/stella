#!/usr/bin/env bun
// A signed-in local stack in one blocking command, for agents and scripts.
//
//   bun run agent:up       start (or reuse) this checkout's seeded stack
//   bun run agent:status   print the live URLs and credentials paths
//   bun run agent:down     stop the stack this checkout started
//   bun run agent:cli ...  run the `stella` CLI against the stack
//   bun run agent:drive .. drive the web app (apps/web/e2e/agent/drive.ts)
//
// `up` runs the dev runner detached with `--seed`, waits for the runtime file
// it writes once every service is ready, then mints a machine API key for the
// seeded owner through the same HTTP route a person would use. Everything it
// produces lives in `.stella-dev/` (gitignored) and is local-only data.

import { Result } from "better-result";
import { spawn } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import { MCP_DEFAULT_RESOURCE_SCOPES } from "@stll/api-contract";
import { roles } from "@stll/permissions";

import {
  DEV_STATE_DIR,
  devStatePath,
  readDevRuntime,
  type DevRuntime,
} from "./dev-runtime";

const RUNNER_SCRIPT = "packages/scripts/src/dev-runner.ts";
const RUNNER_LOG_FILE = "runner.log";
const STARTING_FILE = "starting.pid";
const AGENT_KEY_FILE = "agent-key.json";
const AGENT_ENV_FILE = "agent.env";
// Written by apps/api/scripts/seed-test-user.ts; the e2e suites read it too.
const STORAGE_STATE_PATH = ".playwright/storage-state.json";
const AGENT_KEY_NAME = "local-agent";
// A cold stack pulls images, installs dependencies, migrates and seeds.
const UP_TIMEOUT_MS = 20 * 60_000;
const DOWN_TIMEOUT_MS = 60_000;
const POLL_INTERVAL_MS = 1000;
const HEARTBEAT_MS = 30_000;
const LOG_TAIL_LINES = 40;

const COMMANDS = ["up", "down", "status", "env", "cli", "drive"] as const;
type Command = (typeof COMMANDS)[number];

const isCommand = (value: string | undefined): value is Command =>
  COMMANDS.some((command) => command === value);

// Every failure here is an operator-facing message with a next step, so it is
// printed plainly instead of as a stack trace.
const fail = (message: string): never => {
  console.error(message);
  process.exit(1);
};

const resolveRoot = () => {
  const result = Bun.spawnSync(["git", "rev-parse", "--show-toplevel"], {
    stderr: "pipe",
    stdout: "pipe",
  });
  if (!result.success) {
    fail("Run agent commands inside a stella checkout");
  }
  return result.stdout.toString().trim();
};

const isProcessAlive = (pid: number) =>
  Result.try(() => process.kill(pid, 0)).isOk();

// A recorded pid can belong to an unrelated process after a crash or reboot,
// so a runner is recognised by its command line before it is reused or
// signalled.
const isRunnerProcess = (pid: number) => {
  if (!isProcessAlive(pid)) {
    return false;
  }
  const result = Bun.spawnSync(["ps", "-p", String(pid), "-o", "command="], {
    stderr: "pipe",
    stdout: "pipe",
  });
  return result.success && result.stdout.toString().includes(RUNNER_SCRIPT);
};

const isApiHealthy = async (apiUrl: string) => {
  const response = await Result.tryPromise(
    async () =>
      await fetch(`${apiUrl}/health`, { signal: AbortSignal.timeout(2000) }),
  );
  return Result.isOk(response) && response.value.ok;
};

const liveRuntime = async (root: string): Promise<DevRuntime | null> => {
  const runtime = readDevRuntime(root);
  if (runtime === null || !isRunnerProcess(runtime.pid)) {
    return null;
  }
  if (runtime.apiUrl !== null && !(await isApiHealthy(runtime.apiUrl))) {
    return null;
  }
  return runtime;
};

const tailLog = (root: string) =>
  readFileSync(devStatePath(root, RUNNER_LOG_FILE), "utf-8")
    .trimEnd()
    .split("\n")
    .slice(-LOG_TAIL_LINES)
    .join("\n");

// Written the moment a runner is spawned, so a retry after an interrupted
// `up` joins that runner instead of racing a second one for the same ports.
const readStartingPid = (root: string) => {
  const filePath = devStatePath(root, STARTING_FILE);
  if (!existsSync(filePath)) {
    return null;
  }
  const pid = Number(readFileSync(filePath, "utf-8").trim());
  return Number.isInteger(pid) && isRunnerProcess(pid) ? pid : null;
};

type StartRunnerOptions = { root: string; skipInstall: boolean };

const spawnRunner = ({ root, skipInstall }: StartRunnerOptions) => {
  mkdirSync(path.join(root, DEV_STATE_DIR), { recursive: true });
  const log = openSync(devStatePath(root, RUNNER_LOG_FILE), "w");
  const child = spawn(
    process.execPath,
    [
      path.join(root, RUNNER_SCRIPT),
      "dev",
      "--no-browser",
      "--seed",
      ...(skipInstall ? ["--skip-install"] : []),
    ],
    { cwd: root, detached: true, stdio: ["ignore", log, log] },
  );
  closeSync(log);
  child.unref();
  const pid = child.pid ?? fail("The dev runner did not start");
  writeFileSync(devStatePath(root, STARTING_FILE), `${String(pid)}\n`);
  return pid;
};

type WaitForRunnerOptions = { pid: number; root: string };

const waitForRunner = async ({ pid, root }: WaitForRunnerOptions) => {
  const logPath = devStatePath(root, RUNNER_LOG_FILE);
  // Interrupting `up` stops the runner it is waiting on: a detached runner
  // nobody waits for would hold the ports with no runtime file to find it.
  const stopRunner = () => {
    if (isRunnerProcess(pid)) {
      process.kill(pid, "SIGTERM");
    }
  };
  const onSignal = () => {
    stopRunner();
    fail(`Interrupted; stopped the dev runner (pid ${String(pid)})`);
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  console.log(
    `Waiting for the dev runner (pid ${String(pid)}); log: ${logPath}`,
  );
  const startedAt = Date.now();
  let printedLines = 0;
  let lastProgressAt = startedAt;
  let lastHeading = "starting";
  while (Date.now() - startedAt < UP_TIMEOUT_MS) {
    // Relay the runner's step headings, and a heartbeat during long steps
    // (the seed is silent for a while), so a caller sees where time goes.
    const lines = readFileSync(logPath, "utf-8").split("\n");
    for (const line of lines.slice(printedLines, -1)) {
      if (line.startsWith("==> ")) {
        console.log(line);
        lastHeading = line.slice("==> ".length).replace(/\.+$/u, "");
        lastProgressAt = Date.now();
      }
    }
    printedLines = Math.max(printedLines, lines.length - 1);
    if (Date.now() - lastProgressAt >= HEARTBEAT_MS) {
      console.log(
        `    still ${lastHeading.toLowerCase()} (${String(Math.round((Date.now() - startedAt) / 1000))} s)`,
      );
      lastProgressAt = Date.now();
    }

    const runtime = readDevRuntime(root);
    if (runtime?.pid === pid) {
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
      rmSync(devStatePath(root, STARTING_FILE), { force: true });
      return runtime;
    }
    if (!isRunnerProcess(pid)) {
      console.error(tailLog(root));
      return fail("The dev runner exited before it was ready");
    }
    await Bun.sleep(POLL_INTERVAL_MS);
  }
  console.error(tailLog(root));
  stopRunner();
  return fail(
    `The dev runner was not ready after ${String(UP_TIMEOUT_MS / 60_000)} minutes; stopped it`,
  );
};

type StoredAgentKey = { apiUrl: string; id: string; key: string };

const isStoredAgentKey = (value: unknown): value is StoredAgentKey =>
  typeof value === "object" &&
  value !== null &&
  "apiUrl" in value &&
  typeof value.apiUrl === "string" &&
  "id" in value &&
  typeof value.id === "string" &&
  "key" in value &&
  typeof value.key === "string";

const readStoredAgentKey = (root: string) => {
  const keyPath = devStatePath(root, AGENT_KEY_FILE);
  if (!existsSync(keyPath)) {
    return null;
  }
  const parsed: unknown = JSON.parse(readFileSync(keyPath, "utf-8"));
  return isStoredAgentKey(parsed) ? parsed : null;
};

const readSessionCookie = (root: string) => {
  const parsed: unknown = JSON.parse(
    readFileSync(path.join(root, STORAGE_STATE_PATH), "utf-8"),
  );
  const cookie =
    typeof parsed === "object" &&
    parsed !== null &&
    "cookies" in parsed &&
    Array.isArray(parsed.cookies)
      ? parsed.cookies.at(0)
      : undefined;
  if (
    typeof cookie !== "object" ||
    cookie === null ||
    !("name" in cookie) ||
    typeof cookie.name !== "string" ||
    !("value" in cookie) ||
    typeof cookie.value !== "string"
  ) {
    return fail(`${STORAGE_STATE_PATH} has no session cookie; re-run up`);
  }
  return `${cookie.name}=${cookie.value}`;
};

type ApiRequestOptions = {
  body?: unknown;
  cookie: string;
  method: "GET" | "POST";
  url: string;
};

const apiRequest = async ({ body, cookie, method, url }: ApiRequestOptions) => {
  const response = await fetch(url, {
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: { "content-type": "application/json", cookie },
    method,
  });
  const text = await response.text();
  if (!response.ok) {
    fail(`${method} ${url} -> ${String(response.status)}: ${text}`);
  }
  const parsed: unknown = JSON.parse(text);
  return parsed;
};

const listsKey = (payload: unknown, id: string) =>
  typeof payload === "object" &&
  payload !== null &&
  "items" in payload &&
  Array.isArray(payload.items) &&
  payload.items.some(
    (item: unknown) =>
      typeof item === "object" &&
      item !== null &&
      "id" in item &&
      item.id === id &&
      "enabled" in item &&
      item.enabled === true,
  );

// A key survives restarts as long as the stack keeps its database; a stack
// recreated from empty volumes no longer lists it, so a new one is minted.
const ensureAgentKey = async (root: string, apiUrl: string) => {
  const cookie = readSessionCookie(root);
  const stored = readStoredAgentKey(root);
  if (stored !== null && stored.apiUrl === apiUrl) {
    const listing = await apiRequest({
      cookie,
      method: "GET",
      url: `${apiUrl}/v1/api-keys?limit=100`,
    });
    if (listsKey(listing, stored.id)) {
      return stored;
    }
  }

  const minted = await apiRequest({
    body: {
      name: AGENT_KEY_NAME,
      permissions: roles.owner.statements,
      scopes: MCP_DEFAULT_RESOURCE_SCOPES,
    },
    cookie,
    method: "POST",
    url: `${apiUrl}/v1/api-keys`,
  });
  if (
    typeof minted !== "object" ||
    minted === null ||
    !("id" in minted) ||
    typeof minted.id !== "string" ||
    !("key" in minted) ||
    typeof minted.key !== "string"
  ) {
    return fail("The API key response carried no id and key");
  }
  const agentKey = { apiUrl, id: minted.id, key: minted.key };
  writeFileSync(
    devStatePath(root, AGENT_KEY_FILE),
    `${JSON.stringify(agentKey, null, 2)}\n`,
    { mode: 0o600 },
  );
  return agentKey;
};

type AgentEnvOptions = { apiKey: string; runtime: DevRuntime };

const agentEnv = ({ apiKey, runtime }: AgentEnvOptions) => ({
  E2E_API_URL: runtime.apiUrl ?? "",
  E2E_WEB_URL: runtime.webUrl ?? "",
  STELLA_API_KEY: apiKey,
  STELLA_SERVER_URL: runtime.apiUrl ?? "",
});

const requireRuntime = async (root: string) =>
  (await liveRuntime(root)) ??
  fail("No stack is running for this checkout; run `bun run agent:up`");

const requireAgentEnv = async (root: string) => {
  const runtime = await requireRuntime(root);
  const stored =
    readStoredAgentKey(root) ??
    fail("No agent key yet; run `bun run agent:up`");
  return agentEnv({ apiKey: stored.key, runtime });
};

const printStatus = (root: string, runtime: DevRuntime) => {
  console.log(`web:           ${runtime.webUrl ?? "-"}`);
  console.log(`api:           ${runtime.apiUrl ?? "-"}`);
  console.log(`infra offset:  ${String(runtime.infraOffset)}`);
  console.log(`runner pid:    ${String(runtime.pid)}`);
  console.log(`started:       ${runtime.startedAt}`);
  console.log(`signed in as:  test@stella.dev (owner, Harbrook & Partners)`);
  console.log(`storage state: ${path.join(root, STORAGE_STATE_PATH)}`);
  console.log(`env file:      ${devStatePath(root, AGENT_ENV_FILE)}`);
  console.log(`runner log:    ${devStatePath(root, RUNNER_LOG_FILE)}`);
};

const up = async (root: string, args: readonly string[]) => {
  const reused = await liveRuntime(root);
  const runtime =
    reused ??
    (await waitForRunner({
      pid:
        readStartingPid(root) ??
        spawnRunner({ root, skipInstall: args.includes("--skip-install") }),
      root,
    }));
  if (!runtime.seeded || runtime.apiUrl === null) {
    fail(
      "The running stack was started without --seed; stop it and run `bun run agent:up`",
    );
  }
  const agentKey = await ensureAgentKey(root, runtime.apiUrl);
  const env = agentEnv({ apiKey: agentKey.key, runtime });
  writeFileSync(
    devStatePath(root, AGENT_ENV_FILE),
    `${Object.entries(env)
      .map(([name, value]) => `export ${name}=${value}`)
      .join("\n")}\n`,
    { mode: 0o600 },
  );
  console.log(reused === null ? "Stack ready." : "Reusing the running stack.");
  printStatus(root, runtime);
};

const down = async (root: string) => {
  const runtime = readDevRuntime(root);
  if (runtime === null || !isRunnerProcess(runtime.pid)) {
    console.log("No stack is running for this checkout.");
    return;
  }
  // The runner stops its children and its Docker project on SIGTERM; volumes
  // (and so the seeded database) survive for the next `up`.
  process.kill(runtime.pid, "SIGTERM");
  const deadline = Date.now() + DOWN_TIMEOUT_MS;
  while (isProcessAlive(runtime.pid)) {
    if (Date.now() > deadline) {
      fail(`Runner ${String(runtime.pid)} is still running after SIGTERM`);
    }
    await Bun.sleep(POLL_INTERVAL_MS);
  }
  console.log("Stopped.");
};

type PassThroughOptions = {
  args: readonly string[];
  env: Record<string, string>;
  script: string;
};

const passThrough = async ({ args, env, script }: PassThroughOptions) => {
  const child = Bun.spawn({
    cmd: [process.execPath, script, ...args],
    env: { ...process.env, ...env },
    stderr: "inherit",
    stdin: "inherit",
    stdout: "inherit",
  });
  process.exit(await child.exited);
};

const main = async () => {
  const [command, ...rest] = process.argv.slice(2);
  const args = rest.at(0) === "--" ? rest.slice(1) : rest;
  if (!isCommand(command)) {
    console.error(`Usage: agent-session.ts <${COMMANDS.join("|")}> [args]`);
    process.exit(2);
  }
  const root = resolveRoot();
  switch (command) {
    case "up": {
      await up(root, args);
      return;
    }
    case "down": {
      await down(root);
      return;
    }
    case "status": {
      printStatus(root, await requireRuntime(root));
      return;
    }
    case "env": {
      for (const [name, value] of Object.entries(await requireAgentEnv(root))) {
        console.log(`export ${name}=${value}`);
      }
      return;
    }
    case "cli": {
      await passThrough({
        args,
        env: await requireAgentEnv(root),
        script: path.join(root, "packages/cli/src/cli.ts"),
      });
      return;
    }
    case "drive": {
      await passThrough({
        args,
        env: await requireAgentEnv(root),
        script: path.join(root, "apps/web/e2e/agent/drive.ts"),
      });
      return;
    }
    default: {
      command satisfies never;
    }
  }
};

if (import.meta.main) {
  await main();
}
