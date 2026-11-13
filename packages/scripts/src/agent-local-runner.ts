// The stand-in computer `bun run agent:up -- --local-runner` starts beside a
// seeded stack, so "run this chat on my computer" can be driven end to end
// without the desktop app, a Codex or Claude Code login or a model provider.
//
// It is the desktop crate's own runner, journal, harness host and holder
// (`apps/desktop/src-tauri/src/desktop_runner/stand_in.rs`, built as the
// `runner_stand_in` example behind the `dev-runner-stand-in` feature), linked
// to the seeded owner through the API's desktop-registry endpoints. Codex and
// Claude Code are the agent engine's by-model stand-ins: each model in the
// chat's menu is a scripted scenario.
//
// State lives in `.stella-dev/local-runner/`: the link and device key, the
// CLI wrappers, the stand-ins' logs and the `offline` switch.

import { Result } from "better-result";
import { spawn } from "node:child_process";
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import * as v from "valibot";

import { fetchWithTimeout } from "@stll/fetch";
import { readBodyTextWithIdleDeadline } from "@stll/fetch/body-reader";
import { Temporal } from "@stll/time";

import {
  LOCAL_RUNNER_DATA_FOLDER_FILE,
  LOCAL_RUNNER_LINK_FILE,
  LOCAL_RUNNER_SWITCHES,
  localRunnerDir,
} from "./agent-local-runner-files";
import { devStatePath } from "./dev-runtime";

export const LOCAL_RUNNER_FLAG = "--local-runner";

const MANIFEST = "apps/desktop/src-tauri/Cargo.toml";
const EXAMPLE = "runner_stand_in";
const FEATURE = "dev-runner-stand-in";
const RECORD_FILE = "local-runner.json";
const LOG_FILE = "local-runner.log";
const BUILD_LOG_FILE = "local-runner-build.log";
// The data folder the stand-in names is `.../runner-stand-in/<checkout>`.
const DATA_FOLDER_PARENT = "runner-stand-in";
const CODEX_STAND_IN = "packages/agent-engine/scripts/fake-codex-by-model.ts";
const CLAUDE_CODE_STAND_IN =
  "packages/agent-engine/scripts/fake-claude-code-by-model.ts";
// The holder starts from source and probes both CLIs before reporting.
const READY_TIMEOUT_MS = 120_000;
const STOP_TIMEOUT_MS = 20_000;
const POLL_MS = 1000;
const LOG_TAIL_LINES = 30;

const recordSchema = v.object({
  pid: v.pipe(v.number(), v.integer(), v.minValue(2)),
  executable: v.pipe(v.string(), v.minLength(1)),
  startedAt: v.string(),
});
type LocalRunnerRecord = v.InferOutput<typeof recordSchema>;

const readRecord = (root: string): LocalRunnerRecord | null => {
  const filePath = devStatePath(root, RECORD_FILE);
  if (!existsSync(filePath)) {
    return null;
  }
  const parsed = v.safeParse(
    recordSchema,
    JSON.parse(readFileSync(filePath, "utf-8")),
  );
  return parsed.success ? parsed.output : null;
};

/**
 * Whether the recorded stand-in still runs: a pid is reused after a crash or
 * reboot, so it must still run the recorded executable.
 */
const isStandIn = (record: LocalRunnerRecord) => {
  const result = Bun.spawnSync(
    ["ps", "-p", String(record.pid), "-o", "command="],
    { stderr: "pipe", stdout: "pipe" },
  );
  return (
    result.success &&
    result.stdout.toString().trim().startsWith(record.executable)
  );
};

export const runningLocalRunner = (root: string) => {
  const record = readRecord(root);
  return record !== null && isStandIn(record) ? record : null;
};

const tail = (filePath: string) =>
  existsSync(filePath)
    ? readFileSync(filePath, "utf-8")
        .trimEnd()
        .split("\n")
        .slice(-LOG_TAIL_LINES)
        .join("\n")
    : "";

const elapsed = (since: number) =>
  `${String(Math.round((Temporal.Now.instant().epochMilliseconds - since) / 1000))} s`;

const artifactSchema = v.object({
  reason: v.literal("compiler-artifact"),
  target: v.object({ name: v.string() }),
  executable: v.nullable(v.string()),
});

/**
 * Build the stand-in with Cargo and return its executable. The first build
 * compiles the desktop crate (several minutes); later ones are incremental.
 */
const build = async (root: string): Promise<Result<string, string>> => {
  const logPath = devStatePath(root, BUILD_LOG_FILE);
  const startedAt = Temporal.Now.instant().epochMilliseconds;
  console.log(
    `==> Building the stand-in computer (log: ${logPath}; a first build takes minutes)...`,
  );
  const log = openSync(logPath, "w");
  const child = Bun.spawn({
    cmd: [
      "cargo",
      "build",
      "--manifest-path",
      path.join(root, MANIFEST),
      "--example",
      EXAMPLE,
      "--features",
      FEATURE,
      "--message-format=json-render-diagnostics",
    ],
    cwd: root,
    stderr: log,
    stdout: "pipe",
  });
  const output = await new Response(child.stdout).text();
  await child.exited;
  closeSync(log);
  if (child.exitCode !== 0) {
    return Result.err(
      `Building the stand-in failed (exit ${String(child.exitCode)}):\n${tail(logPath)}`,
    );
  }
  const executable = output
    .split("\n")
    .filter((line) => line.startsWith("{"))
    .map((line) => v.safeParse(artifactSchema, JSON.parse(line)))
    .flatMap((parsed) =>
      parsed.success && parsed.output.target.name === EXAMPLE
        ? [parsed.output.executable]
        : [],
    )
    .at(-1);
  if (executable === undefined || executable === null) {
    return Result.err("Cargo built no stand-in executable");
  }
  console.log(`    built in ${elapsed(startedAt)}`);
  return Result.ok(executable);
};

/**
 * A shell script the host runs as the installed CLI. The harness launch
 * passes on only the environment it chooses, so the stand-in's settings are
 * written into the script.
 */
const writeWrapper = (options: {
  file: string;
  script: string;
  log: string;
}) => {
  const pace = process.env["FAKE_CODEX_PACE_MS"];
  const settings = [
    `FAKE_HARNESS_LOG='${options.log}'`,
    ...(pace !== undefined && /^\d+$/u.test(pace)
      ? [`FAKE_CODEX_PACE_MS=${pace}`]
      : []),
  ];
  writeFileSync(
    options.file,
    [
      "#!/bin/sh",
      "# Written by agent:up --local-runner; the stand-in for an installed CLI.",
      `${settings.join(" ")} exec '${process.execPath}' '${options.script}' "$@"`,
      "",
    ].join("\n"),
  );
  chmodSync(options.file, 0o755);
};

const sessionSchema = v.object({
  user: v.object({ id: v.pipe(v.string(), v.minLength(1)) }),
  session: v.object({
    activeOrganizationId: v.pipe(v.string(), v.minLength(1)),
  }),
});

type StackSession = { apiUrl: string; webUrl: string; cookie: string };

/** The local API answers these at once; a stack that hangs is not ready. */
const STACK_REQUEST_TIMEOUT_MS = 10_000;
/** Far above the readiness and settings bodies these requests read. */
const STACK_RESPONSE_MAX_BYTES = 1024 * 1024;

const stackRequest = async (
  stack: StackSession,
  pathname: string,
  method: "GET" | "PUT" = "GET",
) => {
  const answered = await Result.tryPromise(async () => {
    const response = await fetchWithTimeout(`${stack.apiUrl}${pathname}`, {
      headers: { cookie: stack.cookie, origin: stack.webUrl },
      method,
      timeout: { type: "headers", ms: STACK_REQUEST_TIMEOUT_MS },
    });
    const text = await readBodyTextWithIdleDeadline(response, {
      idleMs: STACK_REQUEST_TIMEOUT_MS,
      maxBytes: STACK_RESPONSE_MAX_BYTES,
    });
    return { ok: response.ok, status: response.status, text };
  });
  if (Result.isError(answered)) {
    return Result.err(`${method} ${pathname}: ${answered.error.message}`);
  }
  const { ok, status, text } = answered.value;
  if (!ok) {
    return Result.err(`${method} ${pathname} -> ${String(status)}: ${text}`);
  }
  const body: unknown = text === "" ? null : JSON.parse(text);
  return Result.ok(body);
};

const readinessSchema = v.variant("status", [
  v.object({ status: v.literal("hidden") }),
  v.object({
    status: v.literal("enabled"),
    runners: v.array(
      v.object({
        desktopId: v.string(),
        connected: v.boolean(),
        harnesses: v.array(
          v.looseObject({
            id: v.string(),
            state: v.string(),
            models: v.optional(v.array(v.object({ id: v.string() }))),
          }),
        ),
      }),
    ),
  }),
]);

const linkSchema = v.object({ desktopId: v.string() });

/**
 * The stand-in's harnesses as the chat sees them once its computer is
 * connected and Codex is ready on it; null until then.
 */
const readyComputer = async (stack: StackSession, desktopId: string) => {
  const readiness = await stackRequest(stack, "/v1/chat/local-runners");
  if (Result.isError(readiness)) {
    return Result.err(readiness.error);
  }
  const parsed = v.safeParse(readinessSchema, readiness.value);
  if (!parsed.success) {
    return Result.err("/v1/chat/local-runners answered an unexpected shape");
  }
  if (parsed.output.status !== "enabled") {
    return Result.err("The chat offers the member no computer (hidden)");
  }
  const computer = parsed.output.runners.find(
    (runner) => runner.desktopId === desktopId && runner.connected,
  );
  return Result.ok(
    computer?.harnesses.some(
      ({ id, state }) => id === "codex" && state === "ready",
    ) === true
      ? computer.harnesses
      : null,
  );
};

type StartOptions = {
  root: string;
  apiUrl: string;
  webUrl: string;
  cookie: string;
  /** A stand-in built elsewhere (CI builds it in its own job); else Cargo builds it. */
  executable?: string;
};

/**
 * Start the stand-in computer for the seeded owner, or reuse a running one,
 * and wait until the chat offers both CLIs on it.
 */
export const startLocalRunner = async ({
  root,
  apiUrl,
  webUrl,
  cookie,
  executable,
}: StartOptions): Promise<Result<void, string>> => {
  const stack = { apiUrl, webUrl, cookie };
  const state = localRunnerDir(root);
  mkdirSync(path.join(state, "bin"), { recursive: true });
  // The member turns the feature on under Beta Features; this is that toggle.
  const enrolled = await stackRequest(
    stack,
    "/v1/organization-settings/feature-enrolments/local-agents",
    "PUT",
  );
  if (Result.isError(enrolled)) {
    return Result.err(`Turning on local agents failed: ${enrolled.error}`);
  }
  const running = runningLocalRunner(root);
  if (running === null) {
    const built =
      executable === undefined ? await build(root) : Result.ok(executable);
    if (Result.isError(built)) {
      return Result.err(built.error);
    }
    const session = await stackRequest(stack, "/api/auth/get-session");
    const identity = Result.isOk(session)
      ? v.safeParse(sessionSchema, session.value)
      : null;
    if (identity === null || !identity.success) {
      return Result.err("The stack's session names no member to link");
    }
    const codex = path.join(state, "bin", "codex");
    const claudeCode = path.join(state, "bin", "claude");
    writeWrapper({
      file: codex,
      script: path.join(root, CODEX_STAND_IN),
      log: path.join(state, "codex.log"),
    });
    writeWrapper({
      file: claudeCode,
      script: path.join(root, CLAUDE_CODE_STAND_IN),
      log: path.join(state, "claude-code.log"),
    });
    for (const name of Object.values(LOCAL_RUNNER_SWITCHES)) {
      rmSync(path.join(state, name), { force: true });
    }
    const logPath = devStatePath(root, LOG_FILE);
    const log = openSync(logPath, "a");
    const child = spawn(built.value, [], {
      cwd: root,
      detached: true,
      stdio: ["ignore", log, log],
      env: {
        ...process.env,
        STELLA_STAND_IN_API: apiUrl,
        STELLA_STAND_IN_WEB: webUrl,
        STELLA_STAND_IN_COOKIE: cookie,
        STELLA_STAND_IN_USER_ID: identity.output.user.id,
        STELLA_STAND_IN_ORGANIZATION_ID:
          identity.output.session.activeOrganizationId,
        STELLA_STAND_IN_STATE: state,
        STELLA_STAND_IN_BUN: process.execPath,
        STELLA_STAND_IN_CODEX: codex,
        STELLA_STAND_IN_CLAUDE_CODE: claudeCode,
      },
    });
    closeSync(log);
    const pid = child.pid;
    if (pid === undefined) {
      return Result.err("The stand-in computer did not start");
    }
    child.unref();
    writeFileSync(
      devStatePath(root, RECORD_FILE),
      `${JSON.stringify({ pid, executable: built.value, startedAt: Temporal.Now.instant().toString() })}\n`,
    );
  }
  const record = runningLocalRunner(root);
  const startedAt = Temporal.Now.instant().epochMilliseconds;
  console.log("==> Waiting for the stand-in computer to report Codex...");
  let lastError = "";
  while (
    Temporal.Now.instant().epochMilliseconds - startedAt <
    READY_TIMEOUT_MS
  ) {
    if (record === null || !isStandIn(record)) {
      return Result.err(
        `The stand-in computer exited:\n${tail(devStatePath(root, LOG_FILE))}`,
      );
    }
    const linkPath = path.join(state, LOCAL_RUNNER_LINK_FILE);
    const link = existsSync(linkPath)
      ? v.safeParse(linkSchema, JSON.parse(readFileSync(linkPath, "utf-8")))
      : null;
    const checked =
      link?.success === true
        ? await readyComputer(stack, link.output.desktopId)
        : Result.ok(null);
    if (Result.isError(checked)) {
      lastError = checked.error;
    }
    const ready = Result.isOk(checked) ? checked.value : null;
    if (ready !== null && link?.success === true) {
      console.log(`    ready in ${elapsed(startedAt)}`);
      printLocalRunner(root, record, {
        desktopId: link.output.desktopId,
        harnesses: ready.map(({ id, state: harnessState, models }) =>
          harnessState === "ready"
            ? `${id}: ${(models ?? []).map((model) => model.id).join(", ")}`
            : `${id}: ${harnessState}`,
        ),
      });
      return Result.ok(undefined);
    }
    await Bun.sleep(POLL_MS);
  }
  return Result.err(
    `The stand-in computer was not ready after ${String(READY_TIMEOUT_MS / 1000)} s${lastError === "" ? "" : ` (last check: ${lastError})`}:\n${tail(devStatePath(root, LOG_FILE))}`,
  );
};

export const printLocalRunner = (
  root: string,
  record: LocalRunnerRecord,
  details?: { desktopId: string; harnesses: string[] },
) => {
  const state = localRunnerDir(root);
  console.log(`local runner:  pid ${String(record.pid)} (stand-in computer)`);
  if (details !== undefined) {
    console.log(`computer:      ${details.desktopId}`);
    for (const harness of details.harnesses) {
      console.log(`  ${harness}`);
    }
  }
  console.log(`runner log:    ${devStatePath(root, LOG_FILE)}`);
  console.log(
    `CLI logs:      ${path.join(state, "codex.log")}, ${path.join(state, "claude-code.log")}`,
  );
  console.log(
    `offline:       touch ${path.join(state, LOCAL_RUNNER_SWITCHES.offline)} (remove it to reconnect)`,
  );
  console.log(
    `relink:        touch ${path.join(state, LOCAL_RUNNER_SWITCHES.relink)} (a new device key for the same computer)`,
  );
};

/** Stop the stand-in computer; it stops its runs and its holder first. */
export const stopLocalRunner = async (root: string) => {
  const record = runningLocalRunner(root);
  if (record !== null) {
    process.kill(record.pid, "SIGTERM");
    const deadline = Temporal.Now.instant().epochMilliseconds + STOP_TIMEOUT_MS;
    while (
      isStandIn(record) &&
      Temporal.Now.instant().epochMilliseconds < deadline
    ) {
      await Bun.sleep(POLL_MS / 4);
    }
    if (isStandIn(record)) {
      process.kill(record.pid, "SIGKILL");
      console.error(
        `The stand-in computer (pid ${String(record.pid)}) did not stop in time; killed it. Its holder may still run.`,
      );
    } else {
      console.log("Stopped the stand-in computer.");
    }
  }
  rmSync(devStatePath(root, RECORD_FILE), { force: true });
};

/**
 * Forget the stand-in's link and remove its data folder (holders, run
 * folders, journal): a recreated database no longer knows its credential or
 * its runs, so the next start links a new computer. `down` keeps both, so a
 * restart reuses the same computer.
 */
export const forgetLocalRunner = (root: string) => {
  const state = localRunnerDir(root);
  const dataFile = path.join(state, LOCAL_RUNNER_DATA_FOLDER_FILE);
  const data = existsSync(dataFile) ? readFileSync(dataFile, "utf-8") : "";
  // Only the folder the stand-in named for itself, never another path.
  if (
    path.isAbsolute(data) &&
    path.basename(path.dirname(data)) === DATA_FOLDER_PARENT
  ) {
    rmSync(data, { recursive: true, force: true });
  }
  rmSync(dataFile, { force: true });
  rmSync(path.join(state, LOCAL_RUNNER_LINK_FILE), { force: true });
};
