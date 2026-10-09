#!/usr/bin/env bun
// A signed-in local stack in one blocking command, for agents and scripts.
//
//   bun run agent:up       start (or reuse) this checkout's seeded stack
//   bun run agent:status   print the live URLs and credentials paths
//   bun run agent:down     stop the stack this checkout started
//   bun run agent:reset    recreate a worktree stack from the seed alone
//   bun run agent:cli ...  run the `stella` CLI against the stack
//   bun run agent:drive .. drive the web app (apps/web/e2e/agent/drive.ts)
//   bun run agent:attach . add drive screenshots to a pull request
//
// `up` runs the dev runner detached with `--seed`, waits for the runtime file
// it writes once every service is ready, then mints a machine API key for the
// seeded owner through the same HTTP route a person would use. Everything it
// produces lives in `.stella-dev/` (gitignored) and is local-only data.

import { panic, Result } from "better-result";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import * as v from "valibot";

import { MCP_DEFAULT_RESOURCE_SCOPES } from "@stll/api-contract";
import { roles } from "@stll/permissions";
import { Temporal } from "@stll/time";

import {
  decideAttachable,
  ghSupportsAttach,
  parseCaptureLog,
  parseManifest,
  parseSealStatus,
  verifyAttachment,
} from "./agent-evidence";
import { childExitStatus } from "./child-exit-status";
import {
  DEV_SESSION_ID_ENV,
  type DevProcessGroupError,
  DevProcessRegistrationError,
  devProcessStartedAt,
  readDevProcessGroups,
  stopDevProcessGroups,
} from "./dev-process-groups";
import { buildStackScriptStep } from "./dev-runner";
import {
  DEV_STATE_DIR,
  devStatePath,
  readDevRuntime,
  SEAL_FILE,
  type DevRuntime,
} from "./dev-runtime";

const RUNNER_SCRIPT = "packages/scripts/src/dev-runner.ts";
const DRIVE_SCRIPT = "apps/web/e2e/agent/drive.ts";
const RUNNER_LOG_FILE = "runner.log";
const STARTING_FILE = "starting.json";
const AGENT_KEY_FILE = "agent-key.json";
const AGENT_ENV_FILE = "agent.env";
// Written by apps/api/scripts/seed-test-user.ts; the e2e suites read it too.
const STORAGE_STATE_PATH = ".playwright/storage-state.json";
const AGENT_KEY_NAME = "local-agent";
// A cold stack pulls images, installs dependencies, migrates and seeds.
const UP_TIMEOUT_MS = 20 * 60_000;
const DOWN_TIMEOUT_MS = 60_000;
const DOWN_FORCE_TIMEOUT_MS = 2000;
const POLL_INTERVAL_MS = 1000;
const HEARTBEAT_MS = 30_000;
const LOG_TAIL_LINES = 40;

const COMMANDS = [
  "up",
  "down",
  "reset",
  "status",
  "env",
  "cli",
  "drive",
  "attach",
  "scheduler-resume",
] as const;
type Command = (typeof COMMANDS)[number];

const isCommand = (value: string | undefined): value is Command =>
  COMMANDS.some((command) => command === value);

// Every failure here is an operator-facing message with a next step, so it is
// printed plainly instead of as a stack trace.
const fail = (message: string): never => {
  console.error(message);
  process.exit(1);
};

const processGroupValue = <T>(result: Result<T, DevProcessGroupError>) =>
  result.match({ ok: (value) => value, err: (error) => fail(error.message) });

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
const isRunnerProcess = (pid: number, root: string) => {
  if (!isProcessAlive(pid)) {
    return false;
  }
  const result = Bun.spawnSync(["ps", "-p", String(pid), "-o", "command="], {
    stderr: "pipe",
    stdout: "pipe",
  });
  return (
    result.success &&
    result.stdout.toString().includes(path.join(root, RUNNER_SCRIPT))
  );
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
  if (runtime === null || !isRunnerProcess(runtime.pid, root)) {
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
const startingSchema = v.object({
  pid: v.pipe(v.number(), v.integer(), v.minValue(2)),
  sessionId: v.pipe(v.string(), v.minLength(1)),
  startedAt: v.string(),
});
const readStartingRunner = (root: string) => {
  const filePath = devStatePath(root, STARTING_FILE);
  if (!existsSync(filePath)) {
    return null;
  }
  return v.parse(startingSchema, JSON.parse(readFileSync(filePath, "utf-8")));
};

type StartRunnerOptions = { root: string; skipInstall: boolean };

const spawnRunner = async ({ root, skipInstall }: StartRunnerOptions) => {
  mkdirSync(path.join(root, DEV_STATE_DIR), { recursive: true });
  const log = openSync(devStatePath(root, RUNNER_LOG_FILE), "w");
  const sessionId = randomUUID();
  const child = spawn(
    process.execPath,
    [
      path.join(root, RUNNER_SCRIPT),
      "dev",
      "--no-browser",
      "--seed",
      ...(skipInstall ? ["--skip-install"] : []),
    ],
    {
      cwd: root,
      detached: true,
      stdio: ["ignore", log, log],
      env: { ...process.env, [DEV_SESSION_ID_ENV]: sessionId },
    },
  );
  closeSync(log);
  const pid = child.pid ?? fail("The dev runner did not start");
  const hasExited = () => child.exitCode !== null || child.signalCode !== null;
  const exit = new Promise<void>((resolve) => {
    child.once("exit", () => {
      resolve();
    });
  });
  const registered = Result.gen(function* () {
    const startedAt = yield* devProcessStartedAt(pid);
    if (startedAt === null) {
      return Result.err(
        new DevProcessRegistrationError({
          message: "The dev runner exited during startup",
        }),
      );
    }
    yield* Result.try({
      try: () => {
        const startingFile = devStatePath(root, STARTING_FILE);
        const temporary = `${startingFile}.${sessionId}.tmp`;
        try {
          writeFileSync(
            temporary,
            `${JSON.stringify({ pid, sessionId, startedAt })}\n`,
          );
          renameSync(temporary, startingFile);
        } finally {
          rmSync(temporary, { force: true });
        }
      },
      catch: (cause) =>
        new DevProcessRegistrationError({
          message: "Cannot record the starting dev runner",
          cause,
        }),
    });
    return Result.ok(undefined);
  });
  if (registered.isErr()) {
    const errors = [registered.error.message];
    for (const signal of ["SIGTERM", "SIGKILL"] as const) {
      if (hasExited()) {
        break;
      }
      const sent = Result.try(() => child.kill(signal));
      if (sent.isErr()) {
        errors.push(`Cannot stop the starting runner: ${sent.error.message}`);
      }
      await Promise.race([exit, Bun.sleep(DOWN_FORCE_TIMEOUT_MS)]);
    }
    if (!hasExited()) {
      fail(`${errors.join("; ")}; runner ${pid} did not exit`);
    }
    await exit;
    const recovered = await stopDevProcessGroups({
      rootDir: root,
      runnerPid: pid,
      sessionId,
    });
    if (recovered.isErr()) {
      errors.push(recovered.error.message);
    }
    fail(errors.join("; "));
  }
  child.unref();
  return pid;
};

type WaitForRunnerOptions = { pid: number; root: string };

const waitForRunner = async ({ pid, root }: WaitForRunnerOptions) => {
  const logPath = devStatePath(root, RUNNER_LOG_FILE);
  const starting = readStartingRunner(root);
  // Interrupting `up` stops the runner it is waiting on: a detached runner
  // nobody waits for would hold the ports with no runtime file to find it.
  const stopRunner = () => {
    if (
      starting?.pid === pid &&
      processGroupValue(devProcessStartedAt(pid)) === starting.startedAt &&
      isRunnerProcess(pid, root)
    ) {
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
  const startedAt = Temporal.Now.instant().epochMilliseconds;
  let printedLines = 0;
  let lastProgressAt = startedAt;
  let lastHeading = "starting";
  while (Temporal.Now.instant().epochMilliseconds - startedAt < UP_TIMEOUT_MS) {
    // Relay the runner's step headings, and a heartbeat during long steps
    // (the seed is silent for a while), so a caller sees where time goes.
    const lines = readFileSync(logPath, "utf-8").split("\n");
    for (const line of lines.slice(printedLines, -1)) {
      if (line.startsWith("==> ")) {
        console.log(line);
        const heading = line.slice("==> ".length);
        lastHeading = heading.endsWith("...") ? heading.slice(0, -3) : heading;
        lastProgressAt = Temporal.Now.instant().epochMilliseconds;
      }
    }
    printedLines = Math.max(printedLines, lines.length - 1);
    if (
      Temporal.Now.instant().epochMilliseconds - lastProgressAt >=
      HEARTBEAT_MS
    ) {
      console.log(
        `    still ${lastHeading.toLowerCase()} (${String(Math.round((Temporal.Now.instant().epochMilliseconds - startedAt) / 1000))} s)`,
      );
      lastProgressAt = Temporal.Now.instant().epochMilliseconds;
    }

    const runtime = readDevRuntime(root);
    if (runtime?.pid === pid) {
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
      if (
        starting &&
        readStartingRunner(root)?.sessionId === starting.sessionId
      ) {
        rmSync(devStatePath(root, STARTING_FILE), { force: true });
      }
      return runtime;
    }
    if (!isRunnerProcess(pid, root)) {
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
  const cookie: unknown =
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
  if (stored?.apiUrl === apiUrl) {
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
  const generation = Bun.spawn({
    cmd: [process.execPath, "run", "generate"],
    cwd: root,
    stdio: ["inherit", "inherit", "inherit"],
  });
  if ((await generation.exited) !== 0) {
    fail(
      "Web source generation failed; fix the generator before starting the stack",
    );
  }
  const reused = await liveRuntime(root);
  const starting = readStartingRunner(root);
  const runtime =
    reused ??
    (await waitForRunner({
      pid:
        (starting &&
        isRunnerProcess(starting.pid, root) &&
        processGroupValue(devProcessStartedAt(starting.pid)) ===
          starting.startedAt
          ? starting.pid
          : null) ??
        (await spawnRunner({
          root,
          skipInstall: args.includes("--skip-install"),
        })),
      root,
    }));
  const apiUrl =
    (runtime.seeded ? runtime.apiUrl : null) ??
    fail(
      "The running stack was started without --seed; stop it and run `bun run agent:up`",
    );
  const agentKey = await ensureAgentKey(root, apiUrl);
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

export const down = async (root: string) => {
  const runtime = readDevRuntime(root);
  const starting = readStartingRunner(root);
  // A runner still starting has no runtime file yet, only its starting pid.
  const startingPid =
    starting && isRunnerProcess(starting.pid, root) ? starting.pid : null;
  const pid =
    runtime !== null && isRunnerProcess(runtime.pid, root)
      ? runtime.pid
      : startingPid;
  const groups = processGroupValue(readDevProcessGroups(root));
  if (pid === null && groups === null) {
    console.log("No stack is running for this checkout.");
    return;
  }
  const runnerPid =
    groups?.runnerPid ?? pid ?? panic("Missing runner ownership");
  const sessionId = groups?.sessionId ?? starting?.sessionId ?? null;
  const runnerStartedAt =
    groups?.runnerStartedAt ?? starting?.startedAt ?? null;
  const isSameRunner = () =>
    pid !== null &&
    runnerStartedAt !== null &&
    isRunnerProcess(pid, root) &&
    processGroupValue(devProcessStartedAt(pid)) === runnerStartedAt &&
    (processGroupValue(readDevProcessGroups(root))?.sessionId ?? sessionId) ===
      sessionId;
  // The runner stops its children and its Docker project on SIGTERM; volumes
  // (and so the seeded database) survive for the next `up`.
  if (pid !== null && isSameRunner()) {
    process.kill(pid, "SIGTERM");
  }
  const deadline = Temporal.Now.instant().epochMilliseconds + DOWN_TIMEOUT_MS;
  if (pid !== null) {
    while (isSameRunner()) {
      if (Temporal.Now.instant().epochMilliseconds > deadline) {
        // Stop registration before recovering the separately owned groups.
        if (isSameRunner()) {
          process.kill(pid, "SIGKILL");
        }
        const forceDeadline = performance.now() + DOWN_FORCE_TIMEOUT_MS;
        while (isSameRunner() && performance.now() < forceDeadline) {
          await Bun.sleep(POLL_INTERVAL_MS);
        }
        if (isSameRunner()) {
          fail(`Runner ${pid} survived SIGKILL`);
        }
        break;
      }
      await Bun.sleep(POLL_INTERVAL_MS);
    }
  }
  processGroupValue(
    await stopDevProcessGroups({ rootDir: root, runnerPid, sessionId }),
  );
  if (starting && readStartingRunner(root)?.sessionId === starting.sessionId) {
    rmSync(devStatePath(root, STARTING_FILE), { force: true });
  }
  console.log("Stopped.");
};

const runStackScript = (
  root: string,
  runtime: DevRuntime,
  { args, label }: { args: string[]; label: string },
) => {
  if (runtime.apiUrl === null || runtime.webUrl === null) {
    return fail("The running stack has no API or web server");
  }
  const step = buildStackScriptStep({
    apiUrl: runtime.apiUrl,
    args,
    infraOffset: runtime.infraOffset,
    label,
    rootDir: root,
    webUrl: runtime.webUrl,
  });
  const result = Bun.spawnSync(step.cmd, {
    cwd: step.cwd,
    env: step.env,
    stderr: "pipe",
    stdout: "pipe",
  });
  if (!result.success) {
    console.error(result.stderr.toString());
    return fail(`${label} failed`);
  }
  return result.stdout.toString();
};

const checkSeal = (root: string, runtime: DevRuntime) =>
  parseSealStatus(
    runStackScript(root, runtime, {
      args: ["scripts/seed-seal.ts", "check", devStatePath(root, SEAL_FILE)],
      label: "Checking the seal",
    }),
  ) ?? fail("The seal check printed no status");

const checkSchedulerPause = (root: string, runtime: DevRuntime) =>
  runStackScript(root, runtime, {
    args: ["scripts/agent-scheduler.ts", "check"],
    label:
      "Checking the sealed stack scheduler pause; run `bun run agent:reset` if lifted",
  });

const EVIDENCE_DIR = "evidence";
const MANIFEST_PATTERN = /^manifest-\d{20}-\d+\.json$/u;

const evidencePath = (root: string, ...segments: string[]) =>
  path.join(root, DEV_STATE_DIR, EVIDENCE_DIR, ...segments);

// Each drive run writes its own manifest, so concurrent runs never rewrite a
// shared file. Names sort by write time, which keeps the latest record for a
// path last.
const readManifest = (root: string) => {
  const dir = evidencePath(root);
  if (!existsSync(dir)) {
    return [];
  }
  return readdirSync(dir)
    .filter((name) => MANIFEST_PATTERN.test(name))
    .toSorted()
    .flatMap((name) =>
      parseManifest(readFileSync(path.join(dir, name), "utf-8")),
    );
};

const writeRunManifest = (root: string, entries: readonly unknown[]) => {
  const writtenAt = Temporal.Now.instant().epochNanoseconds;
  const name = `manifest-${writtenAt.toString().padStart(20, "0")}-${String(process.pid)}.json`;
  const target = evidencePath(root, name);
  const temporary = `${target}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(entries, null, 2)}\n`);
  renameSync(temporary, target);
};

// The driver writes captures; only this process records whether each may be
// attached, after checking the seal on both sides of the run.
export const drive = async (root: string, args: readonly string[]) => {
  const runtime = await requireRuntime(root);
  const env = await requireAgentEnv(root);
  mkdirSync(evidencePath(root), { recursive: true });
  const captureLog = evidencePath(
    root,
    `captures-${String(process.pid)}.jsonl`,
  );
  writeFileSync(captureLog, "");

  const before = checkSeal(root, runtime);
  if (before.status === "pristine" || before.status === "modified") {
    checkSchedulerPause(root, runtime);
  }
  const child = Bun.spawn({
    cmd: [process.execPath, path.join(root, DRIVE_SCRIPT), ...args],
    env: { ...process.env, ...env, STELLA_AGENT_CAPTURE_LOG: captureLog },
    stderr: "inherit",
    stdin: "inherit",
    stdout: "inherit",
  });
  await child.exited;
  const exitCode = childExitStatus(child);
  const after = checkSeal(root, runtime);
  if (after.status === "pristine" || after.status === "modified") {
    checkSchedulerPause(root, runtime);
  }

  const records = parseCaptureLog(readFileSync(captureLog, "utf-8"));
  rmSync(captureLog, { force: true });
  const capturedAt = Temporal.Now.instant().toString();
  const entries = records.map((record) =>
    Object.assign(record, decideAttachable({ after, before, record }), {
      capturedAt,
    }),
  );
  if (entries.length > 0) {
    writeRunManifest(root, entries);
    const refused = entries.find((entry) => !entry.attachable);
    console.log(
      refused === undefined
        ? "\nThese screenshots show only seeded content; `bun run agent:attach` accepts them."
        : `\nThese screenshots cannot be attached to a pull request: ${refused.reason ?? ""}`,
    );
  }
  process.exit(exitCode);
};

const sha256File = (filePath: string) =>
  createHash("sha256").update(readFileSync(filePath)).digest("hex");

// The only way screenshots reach a pull request: each must be an unaltered
// agent:drive capture of a stack that held only seeded content.
const attach = (root: string, args: readonly string[]) => {
  const [pullRequest, ...files] = args;
  if (
    pullRequest === undefined ||
    !/^\d+$/u.test(pullRequest) ||
    files.length === 0
  ) {
    return fail("Usage: bun run agent:attach <pr number> <screenshot.png>...");
  }
  const version = Bun.spawnSync(["gh", "--version"], { stdout: "pipe" });
  if (!ghSupportsAttach(version.stdout.toString())) {
    return fail("gh 2.101 or later is needed for --attach; update gh");
  }

  const manifest = readManifest(root);
  const evidenceDir = realpathSync(evidencePath(root));
  const attachments: string[] = [];
  for (const file of files) {
    if (!existsSync(file)) {
      return fail(`${file} does not exist`);
    }
    const filePath = realpathSync(file);
    const verdict = verifyAttachment({
      evidenceDir,
      filePath,
      fileSha256: sha256File(filePath),
      manifest,
    });
    switch (verdict.type) {
      case "refused": {
        return fail(`Refused: ${verdict.reason}`);
      }
      case "ok": {
        attachments.push(`${filePath}#${verdict.entry.label}`);
        break;
      }
      default: {
        verdict satisfies never;
        return panic(`Unhandled verdict: ${JSON.stringify(verdict)}`);
      }
    }
  }

  const result = Bun.spawnSync(
    [
      "gh",
      "pr",
      "edit",
      pullRequest,
      ...attachments.flatMap((attachment) => ["--attach", attachment]),
    ],
    { stderr: "inherit", stdout: "inherit" },
  );
  return process.exit(childExitStatus(result));
};

// Worktree stacks only: the root checkout's database may hold the person's
// own data, and a reset must never be able to reach it.
const WORKTREE_PROJECT_PATTERN = /^stella-dev-\d+-[a-f0-9]{12}$/u;

const reset = async (root: string, args: readonly string[]) => {
  const runtime = await requireRuntime(root);
  if (
    runtime.dockerProject === null ||
    !WORKTREE_PROJECT_PATTERN.test(runtime.dockerProject) ||
    // At offset 0 the stack uses the DATABASE_URL from apps/api/.env, which a
    // worktree shares with the root checkout.
    runtime.infraOffset === 0
  ) {
    fail(
      "Only a worktree's own stack can be reset; this one may hold your data",
    );
  }
  runStackScript(root, runtime, {
    args: ["scripts/seed-reset.ts", "--confirm-local-reset"],
    label: "Recreating the database",
  });
  await down(root);
  rmSync(devStatePath(root, AGENT_KEY_FILE), { force: true });
  await up(root, args);
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
  await child.exited;
  return childExitStatus(child);
};

const printHelp = () => {
  console.log(`Usage: agent-session.ts <${COMMANDS.join("|")}> [args]`);
  console.log(
    "Agent stacks settle due scheduler jobs, seal content and pause scheduling. For scheduler behaviour: `bun run agent:scheduler-resume`, exercise the stack, then `bun run agent:reset` to reseed, settle, reseal and pause before captures.",
  );
};

const main = async () => {
  const [command, ...rest] = process.argv.slice(2);
  const args = rest.at(0) === "--" ? rest.slice(1) : rest;
  if (
    command === "--help" ||
    command === "-h" ||
    args.at(0) === "--help" ||
    args.at(0) === "-h"
  ) {
    printHelp();
    return;
  }
  if (!isCommand(command)) {
    printHelp();
    process.exit(2);
  }
  const root = resolveRoot();
  switch (command) {
    case "scheduler-resume": {
      runStackScript(root, await requireRuntime(root), {
        args: ["scripts/agent-scheduler.ts", "resume"],
        label: "Resuming the agent stack scheduler",
      });
      console.log(
        "Scheduler resumed. Run `bun run agent:reset` to reseal and pause before agent:drive.",
      );
      break;
    }
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
      const env = await requireAgentEnv(root);
      const generated = await passThrough({
        args: ["--runtime-only"],
        env: {},
        script: path.join(root, "packages/cli/src/codegen.ts"),
      });
      if (generated !== 0) {
        process.exitCode = generated;
        return;
      }
      process.exitCode = await passThrough({
        args,
        env,
        script: path.join(root, "packages/cli/src/cli.ts"),
      });
      return;
    }
    case "reset": {
      await reset(root, args);
      return;
    }
    case "drive": {
      await drive(root, args);
      return;
    }
    case "attach": {
      attach(root, args);
      return;
    }
    default: {
      command satisfies never;
      panic(`Unhandled command: ${String(command)}`);
    }
  }
};

if (import.meta.main) {
  await main();
}
