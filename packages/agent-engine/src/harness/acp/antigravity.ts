import { Result } from "better-result";
import {
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { Temporal } from "temporal-polyfill/full";
import * as v from "valibot";

import type {
  AcpAgentDefinition,
  AcpDiscardSessionContext,
  AcpErrorClassification,
} from "./definition";
import type { AcpToolCallState } from "./tool-calls";

/**
 * Google Antigravity's ACP server, as its release ships it: the server
 * beside the local harness it drives. It keeps its state, sign-in included,
 * in `GEMINI_HOME`, here the stella-owned directory, with its token in a
 * file there rather than the keychain, so the member's own Antigravity and
 * Gemini setup is never read or changed.
 */

const harnessFile = (platform: NodeJS.Platform) =>
  platform === "win32" ? "localharness_external.exe" : "localharness_external";

/** Credentials and projects the member set for their own Google tools. */
const GOOGLE_ENVIRONMENT = [
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "GOOGLE_CLOUD_PROJECT",
  "GOOGLE_CLOUD_LOCATION",
  "GOOGLE_CLOUD_QUOTA_PROJECT",
  "GOOGLE_GENAI_USE_VERTEXAI",
  "GCLOUD_PROJECT",
  "CLOUDSDK_CORE_PROJECT",
  "AGY_ACP_CCPA_PROJECT",
  "AGY_ACP_ENABLE_OAUTH",
  "GEMINI_HOME",
  "CHROME_CRASHPAD_PIPE_NAME",
] as const;

/** Where the server keeps the sign-in a member made through it. */
export const antigravityTokenPath = (configDir: string) =>
  path.join(configDir, "antigravity-acp", "acp_token.json");

/** Signing in with a Google account, the method stella offers. */
const ANTIGRAVITY_SIGN_IN_METHOD = "oauth-personal";

const LOST_THINKING_SIGNATURE =
  /thinking\.signature|invalid `?signature`? in `?thinking`? block/iu;

/**
 * Upstream Google API / Antigravity error patterns (ported from t3code, MIT,
 * `AntigravityTurnOutcome.ts`).
 */
const API_ERROR = /Error (\d{3}), Message: (.+?), Status: ([A-Z_]+)/su;
const STATUS_ERROR = /(?<![A-Z_])([A-Z_]+) \(code (\d{3})\): (\P{Cc}+)/u;
const QUOTA_EXHAUSTED = /\breason:QUOTA_EXHAUSTED\b/u;
const RESET_TIMESTAMP = /\bquotaResetTimeStamp:([^\s\],]+)/u;
const RESET_DELAY =
  /\bquotaResetDelay:((?:\d+(?:\.\d+)?(?:ns|us|µs|μs|ms|h|m|s))+)(?=[\s\],]|$)/u;
const RETRY_DELAY =
  /\bretryDelay:((?:\d+(?:\.\d+)?(?:ns|us|µs|μs|ms|h|m|s))+)(?=[\s\],]|$)/u;
// The lookbehind starts each amount at its first digit, so a retry never
// re-walks the digits the previous attempt consumed.
const GO_DURATION_PART = /(?<![\d.])(\d+(?:\.\d+)?)(ns|us|µs|μs|ms|h|m|s)/gu;
const DURATION_AMOUNT = v.pipe(v.string(), v.decimal(), v.toNumber());
const GO_DURATION_UNIT_MS: Readonly<Record<string, number>> = {
  ns: 1e-6,
  us: 1e-3,
  µs: 1e-3,
  μs: 1e-3,
  ms: 1,
  s: 1000,
  m: 60_000,
  h: 3_600_000,
};

const SAFE_SESSION_ID = /^[\w-]+$/u;
const SESSION_CONVERSATION_SUFFIXES = [
  ".db",
  ".db-wal",
  ".db-shm",
  ".db-journal",
  ".meta",
] as const;

/** Every launch unpacks the server, so a probe's answer is kept this long. */
const PROBE_CACHE_MS = 6 * 60 * 60 * 1000;

/**
 * Antigravity ends `session/prompt` while a backgrounded shell command is
 * still running, and replies once the command exits. A daemon never finishes
 * on its own, so it does not hold the turn open (approach from t3code, MIT,
 * pingdotgg/t3code#38916).
 */
export const antigravityCommandOutlivesPrompt = (
  call: AcpToolCallState,
): boolean => {
  if (call.kind !== "execute") {
    return false;
  }
  const input = call.rawInput;
  return !(
    typeof input === "object" &&
    input !== null &&
    Reflect.get(input, "IsDaemon") === true
  );
};

const parseResetAt = (text: string, now: Temporal.Instant): string | null => {
  const timestamp = RESET_TIMESTAMP.exec(text)?.[1];
  if (timestamp !== undefined) {
    const parsed = Result.try(() => Temporal.Instant.from(timestamp));
    if (Result.isOk(parsed)) {
      return parsed.value.toString();
    }
  }
  const delay = RESET_DELAY.exec(text)?.[1] ?? RETRY_DELAY.exec(text)?.[1];
  if (delay === undefined) {
    return null;
  }
  let delayMs = 0;
  for (const match of delay.matchAll(GO_DURATION_PART)) {
    const amount = v.safeParse(DURATION_AMOUNT, match[1]);
    const unit = match[2] ?? "";
    const factor = GO_DURATION_UNIT_MS[unit] ?? 0;
    delayMs += amount.success ? amount.output * factor : 0;
  }
  if (delayMs <= 0) {
    return null;
  }
  return Temporal.Instant.fromEpochMilliseconds(
    now.epochMilliseconds + Math.ceil(delayMs),
  ).toString();
};

const parseApiError = (
  text: string,
): readonly [httpStatus: string, message: string, status: string] | null => {
  const apiMatch = API_ERROR.exec(text);
  if (apiMatch !== null) {
    return [apiMatch[1] ?? "", (apiMatch[2] ?? "").trim(), apiMatch[3] ?? ""];
  }
  const statusMatch = STATUS_ERROR.exec(text);
  if (statusMatch !== null) {
    return [
      statusMatch[2] ?? "",
      (statusMatch[3] ?? "").trim(),
      statusMatch[1] ?? "",
    ];
  }
  return null;
};

/**
 * Classifies Antigravity failures from captured stderr and prompt errors
 * (ported from t3code, MIT, `AntigravityTurnOutcome.ts` / #39869).
 */
export const classifyAntigravityError = ({
  stderr,
  errorMessage,
  stopReason,
  reachedModel,
  now,
}: {
  stderr: string;
  errorMessage: string | null;
  stopReason: string | null;
  reachedModel: boolean;
  now: Temporal.Instant;
}): AcpErrorClassification | null => {
  const text = [errorMessage ?? "", stderr]
    .filter((part) => part !== "")
    .join("\n");
  if (text === "" && stopReason !== "refusal") {
    return null;
  }
  if (LOST_THINKING_SIGNATURE.test(text)) {
    return {
      failure: {
        type: "provider_error",
        message:
          "Antigravity's saved conversation can no longer be sent to the model. Send another message to continue in a fresh session.",
        code: "INVALID_THINKING_SIGNATURE",
      },
      brokenSession: true,
    };
  }
  const apiError = parseApiError(text);
  if (stopReason === "refusal" || QUOTA_EXHAUSTED.test(text)) {
    return {
      failure: {
        type: "usage_limit",
        message: "You have reached your Antigravity quota for this period.",
        resetsAt: parseResetAt(text, now),
      },
      brokenSession: false,
    };
  }
  if (apiError === null) {
    return null;
  }
  const [httpStatus, message, status] = apiError;
  if (httpStatus === "401" || status === "UNAUTHENTICATED") {
    return {
      failure: {
        type: "auth_required",
        message:
          message || "Antigravity is not signed in. Sign in and try again.",
      },
      brokenSession: false,
    };
  }
  if (httpStatus === "429" || status === "RESOURCE_EXHAUSTED") {
    return {
      failure: {
        type: "usage_limit",
        message:
          message || "You have reached your Antigravity quota for this period.",
        resetsAt: parseResetAt(text, now),
      },
      brokenSession: false,
    };
  }
  if (httpStatus === "404" && reachedModel) {
    return {
      failure: {
        type: "provider_error",
        message:
          message ||
          "Antigravity hit a transient 404 error mid-turn. Send another message to continue.",
        code: status || "NOT_FOUND",
      },
      brokenSession: false,
    };
  }
  return {
    failure: {
      type: "provider_error",
      message: message || "Antigravity stopped this turn because of an error.",
      code: status || httpStatus || "error",
    },
    brokenSession: false,
  };
};

/** Removes `target` only if it is not a symlink; ignores missing or busy entries. */
const removeUnlinkedQuietly = (target: string): boolean => {
  const stat = Result.try(() => lstatSync(target));
  if (Result.isError(stat) || stat.value.isSymbolicLink()) {
    return false;
  }
  return Result.isOk(
    Result.try(() => {
      rmSync(target, { recursive: true, force: true });
    }),
  );
};

const normalizedPathKey = (target: string): string => {
  const real = Result.try(() => realpathSync.native(target));
  const resolved = Result.isOk(real) ? real.value : path.resolve(target);
  return path.sep === "\\" ? resolved.toLowerCase() : resolved;
};

/**
 * Removes a throwaway probe session from `<home>/antigravity-acp` without
 * following symlinks. When `verifyCwd` is set (for the member's own CLI
 * home), `.meta` — if present — must match `cwd` so another session is never
 * touched.
 */
const discardFromAntigravityHome = ({
  homeDir,
  sessionId,
  cwd,
  verifyCwd,
}: {
  homeDir: string;
  sessionId: string;
  cwd: string;
  verifyCwd: boolean;
}) => {
  if (!SAFE_SESSION_ID.test(sessionId)) {
    return;
  }
  const state = path.join(homeDir, "antigravity-acp");
  const stateStat = Result.try(() => lstatSync(state));
  if (
    Result.isError(stateStat) ||
    stateStat.value.isSymbolicLink() ||
    !stateStat.value.isDirectory()
  ) {
    return;
  }
  const isRealDirectory = (dirPath: string): boolean => {
    const stat = Result.try(() => lstatSync(dirPath));
    return (
      Result.isOk(stat) &&
      !stat.value.isSymbolicLink() &&
      stat.value.isDirectory()
    );
  };
  const conversations = path.join(state, "conversations");
  const base = path.join(conversations, sessionId);
  const conversationsSafe = isRealDirectory(conversations);
  if (verifyCwd) {
    if (!conversationsSafe) {
      return;
    }
    if (existsSync(`${base}.meta`)) {
      const metaRaw = Result.try(() => readFileSync(`${base}.meta`, "utf-8"));
      if (Result.isError(metaRaw)) {
        return;
      }
      const metaParsed = Result.try((): unknown => JSON.parse(metaRaw.value));
      if (
        Result.isError(metaParsed) ||
        typeof metaParsed.value !== "object" ||
        metaParsed.value === null
      ) {
        return;
      }
      const metaCwd: unknown = Reflect.get(metaParsed.value, "cwd");
      if (
        typeof metaCwd !== "string" ||
        normalizedPathKey(metaCwd) !== normalizedPathKey(cwd)
      ) {
        return;
      }
    }
  }
  if (conversationsSafe) {
    for (const suffix of SESSION_CONVERSATION_SUFFIXES) {
      removeUnlinkedQuietly(`${base}${suffix}`);
    }
  }
  const brainDir = path.join(state, "brain");
  if (isRealDirectory(brainDir)) {
    removeUnlinkedQuietly(path.join(brainDir, sessionId));
  }
  const annotationsDir = path.join(state, "annotations");
  if (isRealDirectory(annotationsDir)) {
    removeUnlinkedQuietly(path.join(annotationsDir, `${sessionId}.pbtxt`));
  }
};

export const ANTIGRAVITY: AcpAgentDefinition = {
  harness: "antigravity",
  displayName: "Antigravity",
  // The Linux build asks for a user id it does not use.
  args: (platform) => (platform === "linux" ? ["--uid="] : []),
  environment: ({ configDir, executable, platform }) => ({
    GEMINI_HOME: configDir,
    AGY_ACP_FORCE_FILE_STORAGE: "1",
    PYTHONUNBUFFERED: "1",
    ANTIGRAVITY_HARNESS_PATH: path.join(
      path.dirname(executable),
      harnessFile(platform),
    ),
  }),
  removedEnvironment: GOOGLE_ENVIRONMENT,
  approvalModes: ["ask", "auto"],
  // stella answers or asks every permission request; the agent's own modes
  // that skip them stay off.
  sessionModes: { ask: "default", auto: "default" },
  storedSignIn: {
    methodId: ANTIGRAVITY_SIGN_IN_METHOD,
    signedIn: (configDir) => existsSync(antigravityTokenPath(configDir)),
  },
  // Each launch unpacks the server into the temporary directory and leaves
  // it there when the process is stopped.
  ownTempDir: true,
  probeCacheMs: PROBE_CACHE_MS,
  // From 1.5.0 a prompt sent during a turn steers it, keeping its tools and
  // subagents running; earlier releases queue it.
  steers: (version) => Bun.semver.satisfies(version, ">=1.5.0"),
  // A model request that lost its thinking block's signature fails every
  // later request of the saved session too.
  brokenSession: (message) => LOST_THINKING_SIGNATURE.test(message),
  toolOutlivesPrompt: antigravityCommandOutlivesPrompt,
  classifyErrorOutput: classifyAntigravityError,
  minimumVersion: null,
  // A probe's session would otherwise stay in the member's history.
  discardSession: ({ configDir, sessionId, cwd }: AcpDiscardSessionContext) => {
    discardFromAntigravityHome({
      homeDir: configDir,
      sessionId,
      cwd,
      verifyCwd: false,
    });
  },
};

/** The Antigravity CLI serves ACP (`agy acp`) from this release. */
const CLI_ACP_VERSION = "1.5.0";

/** How long `agy --version` may take. */
const CLI_VERSION_TIMEOUT_MS = 5000;

const VERSION_WORD = /\b\d{1,9}\.\d{1,9}\.\d{1,9}\b/u;

/** The CLI's version as `--version` prints it, without starting the agent. */
const cliVersion = async (executable: string): Promise<string | null> => {
  // Throws, and so rejects, when the executable cannot be run at all.
  const child = Bun.spawn([executable, "--version"], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
    timeout: CLI_VERSION_TIMEOUT_MS,
  });
  const [output, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    child.exited,
  ]);
  return exitCode === 0 ? (VERSION_WORD.exec(output)?.[0] ?? null) : null;
};

/** Where the member's own Antigravity CLI keeps its home. */
const antigravityCliHome = (
  environment: Readonly<Record<string, string | undefined>>,
) =>
  environment["GEMINI_HOME"] ??
  path.join(
    environment["HOME"] ?? environment["USERPROFILE"] ?? homedir(),
    ".gemini",
  );

/** Where the member's own Antigravity CLI keeps its sign-in. */
export const antigravityCliTokenPath = (
  environment: Readonly<Record<string, string | undefined>>,
) =>
  path.join(
    antigravityCliHome(environment),
    "antigravity-cli",
    "antigravity-oauth-token",
  );

/**
 * The Antigravity CLI the member installed (`agy`), which serves ACP as
 * `agy acp` from 1.5.0. It is the member's own: it runs with their own
 * Antigravity home and sign-in, which they make in the CLI itself; stella
 * keeps only its own state (the probe's answer) in its state directory.
 */
export const ANTIGRAVITY_CLI: AcpAgentDefinition = {
  ...ANTIGRAVITY,
  args: () => ["acp"],
  environment: () => ({}),
  // The member's own Antigravity home stays theirs.
  removedEnvironment: GOOGLE_ENVIRONMENT.filter(
    (name) => name !== "GEMINI_HOME",
  ),
  storedSignIn: {
    methodId: ANTIGRAVITY_SIGN_IN_METHOD,
    signedIn: (_configDir, environment) =>
      existsSync(antigravityCliTokenPath(environment)),
  },
  ownTempDir: false,
  // Remove throwaway probe sessions from the member's own Antigravity home.
  discardSession: ({
    sessionId,
    environment,
    cwd,
  }: AcpDiscardSessionContext) => {
    discardFromAntigravityHome({
      homeDir: antigravityCliHome(environment),
      sessionId,
      cwd,
      verifyCwd: true,
    });
  },
  minimumVersion: { version: CLI_ACP_VERSION, read: cliVersion },
};

/** The CLI's executable names; the release's server is any other. */
const CLI_NAMES: ReadonlySet<string> = new Set(["agy", "antigravity"]);

/** The definition for an Antigravity executable: the CLI or the server. */
export const antigravityDefinition = (
  executable: string,
): AcpAgentDefinition =>
  CLI_NAMES.has(
    // Either separator: a Windows path is read on every platform.
    path.win32
      .basename(executable)
      .replace(/\.(?:exe|cmd|bat)$/iu, "")
      .toLowerCase(),
  )
    ? ANTIGRAVITY_CLI
    : ANTIGRAVITY;
