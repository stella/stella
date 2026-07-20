/**
 * Post-deploy chat smoke against a *deployed* API.
 *
 * CI builds and the in-repo image smokes run with an AI key present in
 * the test environment, so a config-dependent runtime break that only
 * appears under the actually-deployed configuration (for example a
 * bring-your-own-key deployment where no platform AI key is set, or a
 * provider that fails to initialize from the deployed secrets) never
 * shows up before users do. This script runs an authenticated request
 * against the deployed API and treats any 5xx (or an SSE error frame on
 * the chat stream) as a failed deploy. It is a catch-all: it does not
 * care *why* a route 5xxes, only that one does.
 *
 * Auth reuses the existing secret-guarded smoke-session mechanism
 * (`POST /smoke/session`, handlers/smoke + lib/smoke-session). That
 * route exists only where SMOKE_SESSION_SECRET is configured, which
 * infrastructure injects on non-production deployments only, so this
 * script is a staging-only check by construction.
 *
 * Self-contained on purpose: it imports nothing from the app (no DB
 * client, no env module) so it can run as a standalone `bun` invocation
 * from a deploy job without booting the server or opening a connection.
 */

import { TaggedError } from "better-result";
import * as v from "valibot";

import { detached } from "@/api/lib/detached";
import { fetchWithTimeout } from "@/api/lib/fetch";

const SMOKE_SESSION_TIMEOUT_MS = 15_000;
const READ_CHECK_TIMEOUT_MS = 15_000;
const CHAT_SEND_TIMEOUT_MS = 60_000;
const REVISION_READINESS_TIMEOUT_MS = 600_000;
const REVISION_READINESS_INTERVAL_MS = 5000;
const REVISION_READINESS_LOG_INTERVAL_MS = 30_000;
const REVISION_READINESS_STABLE_SAMPLES = 3;
// Cap how much of the chat SSE stream we read while looking for an
// early error frame. A healthy turn streams far more than this; we only
// need the opening frames to tell "started streaming" from "failed".
const CHAT_STREAM_PREFIX_BYTES = 64 * 1024;
const CHAT_STREAM_READ_TIMEOUT_MS = 20_000;
const AI_UNAVAILABLE_STATUS = 403;
const AI_UNAVAILABLE_MESSAGE_FRAGMENT = "AI is not available";
const CHAT_STREAM_CONTENT_TYPE = "text/event-stream";

class PostDeploySmokeError extends TaggedError("PostDeploySmokeError")<{
  message: string;
  cause?: unknown;
}>() {}

const smokeSessionSchema = v.strictObject({
  cookieName: v.string(),
  cookieValue: v.string(),
  expiresAt: v.string(),
});

type SmokeSession = v.InferOutput<typeof smokeSessionSchema>;

type ChatSmokeBody = {
  threadId: string;
  sendMode: "rawOverride";
  message: {
    id: string;
    role: "user";
    parts: { type: "text"; text: string }[];
  };
};

const CHECK_MODE = {
  /** Pass only on a 2xx status (used for the auth precondition). */
  okOnly: "okOnly",
  /** Pass on 2xx, or the explicit no-AI 403 business response. */
  chatSend: "chatSend",
} as const;

type HttpCheck =
  | {
      name: string;
      status: number;
      mode: typeof CHECK_MODE.okOnly;
    }
  | {
      body: string;
      name: string;
      status: number;
      mode: typeof CHECK_MODE.chatSend;
    };

type EvaluatedCheck = {
  name: string;
  ok: boolean;
  detail: string;
};

/** 5xx is the failure signal: a config-dependent runtime break. */
export const isServerError = (status: number): boolean =>
  status >= 500 && status <= 599;

const isSuccess = (status: number): boolean => status >= 200 && status < 300;

export const isExpectedChatBusinessResponse = (
  status: number,
  body: string,
): boolean =>
  status === AI_UNAVAILABLE_STATUS &&
  body.includes(AI_UNAVAILABLE_MESSAGE_FRAGMENT);

export const evaluateHttpCheck = (check: HttpCheck): EvaluatedCheck => {
  if (check.mode === CHECK_MODE.okOnly) {
    return {
      name: check.name,
      ok: isSuccess(check.status),
      detail: `${String(check.status)} (expected 2xx)`,
    };
  }

  const ok =
    isSuccess(check.status) ||
    isExpectedChatBusinessResponse(check.status, check.body);
  return {
    name: check.name,
    ok,
    detail: `${String(check.status)} (expected 2xx stream or 403 no-AI response)`,
  };
};

const isChatStreamContentType = (contentType: string | null): boolean => {
  if (!contentType) {
    return false;
  }
  const mediaType = contentType.split(";").at(0)?.trim().toLowerCase();
  return mediaType === CHAT_STREAM_CONTENT_TYPE;
};

export const evaluateChatStreamContentType = (
  contentType: string | null,
): EvaluatedCheck => {
  const observed =
    contentType && contentType.trim().length > 0
      ? contentType.trim()
      : "missing";
  return {
    name: "POST /v1/chat/ (stream content-type)",
    ok: isChatStreamContentType(contentType),
    detail: `${observed} (expected ${CHAT_STREAM_CONTENT_TYPE})`,
  };
};

/**
 * The chat handler streams an AI SDK UI-message stream. Errors thrown
 * inside the stream are emitted as `{"type":"error",...}` SSE frames
 * (stream-chat.ts) rather than an HTTP status, so a 200 alone does not
 * prove the turn started cleanly. Scan the buffered prefix for that
 * frame; its presence means the chat turn failed.
 */
export const streamPrefixHasError = (prefix: string): boolean =>
  prefix.includes('"type":"error"');

const MEANINGFUL_CHAT_STREAM_FRAME_TYPES = new Set([
  "finish",
  "text-delta",
  "tool-input-available",
  "tool-output-available",
]);

const parseStreamDataFrames = (prefix: string): unknown[] => {
  const frames: unknown[] = [];
  for (const line of prefix.split(/\r?\n/u)) {
    if (!line.startsWith("data:")) {
      continue;
    }

    const data = line.slice("data:".length).trim();
    if (data.length === 0) {
      continue;
    }

    try {
      frames.push(JSON.parse(data));
    } catch {
      // The prefix can end mid-frame; a later read will complete it.
    }
  }
  return frames;
};

const getStringFrameProperty = (
  frame: unknown,
  property: string,
): string | null => {
  if (typeof frame !== "object" || frame === null || !(property in frame)) {
    return null;
  }

  const value = Reflect.get(frame, property);
  return typeof value === "string" ? value : null;
};

const getStreamFrameType = (frame: unknown): string | null =>
  getStringFrameProperty(frame, "type");

const streamPrefixHasDataFrame = (prefix: string): boolean =>
  parseStreamDataFrames(prefix).length > 0;

export const streamPrefixHasMeaningfulFrame = (prefix: string): boolean =>
  parseStreamDataFrames(prefix).some((frame) => {
    const type = getStreamFrameType(frame);
    if (type === "text-delta") {
      const delta = getStringFrameProperty(frame, "delta");
      return delta !== null && delta.length > 0;
    }
    return type !== null && MEANINGFUL_CHAT_STREAM_FRAME_TYPES.has(type);
  });

export const evaluateChatStreamPrefix = (prefix: string): EvaluatedCheck => {
  if (!streamPrefixHasDataFrame(prefix)) {
    return {
      name: "POST /v1/chat/ (stream)",
      ok: false,
      detail: "stream closed before emitting a data frame",
    };
  }

  if (streamPrefixHasError(prefix)) {
    return {
      name: "POST /v1/chat/ (stream)",
      ok: false,
      detail: "stream emitted an error frame",
    };
  }

  if (!streamPrefixHasMeaningfulFrame(prefix)) {
    return {
      name: "POST /v1/chat/ (stream)",
      ok: false,
      detail: "stream closed before assistant progress or finish",
    };
  }

  return {
    name: "POST /v1/chat/ (stream)",
    ok: true,
    detail: "stream made assistant progress without an error frame",
  };
};

export const allChecksPassed = (checks: EvaluatedCheck[]): boolean =>
  checks.every((check) => check.ok);

type HealthRevisionInput = {
  body: unknown;
  expectedCommit: string | undefined;
  status: number;
};

const getObjectProperty = (value: unknown, property: string): unknown => {
  if (typeof value !== "object" || value === null || !(property in value)) {
    return undefined;
  }
  return Reflect.get(value, property);
};

const getCommitFromHealthBody = (body: unknown): string | null => {
  const commit = getObjectProperty(body, "commit");
  if (typeof commit === "string") {
    return commit;
  }
  return null;
};

export const evaluateHealthRevision = ({
  body,
  expectedCommit,
  status,
}: HealthRevisionInput): EvaluatedCheck => {
  const httpCheck = evaluateHttpCheck({
    name: "GET /health",
    status,
    mode: CHECK_MODE.okOnly,
  });
  if (!httpCheck.ok || !expectedCommit) {
    return httpCheck;
  }

  const commit = getCommitFromHealthBody(body);
  if (commit === expectedCommit) {
    return {
      name: "GET /health",
      ok: true,
      detail: `${String(status)} serving ${commit}`,
    };
  }

  return {
    name: "GET /health",
    ok: false,
    detail: commit
      ? `${String(status)} serving stale commit ${commit}`
      : `${String(status)} without a commit marker`,
  };
};

const sessionCookieHeader = (session: SmokeSession): string =>
  `${session.cookieName}=${session.cookieValue}`;

const parseSmokeSession = (value: unknown): SmokeSession => {
  const parsed = v.safeParse(smokeSessionSchema, value);
  if (parsed.success) {
    return parsed.output;
  }
  throw new PostDeploySmokeError({
    message: "Smoke session response did not match the expected shape",
    cause: parsed.issues,
  });
};

/**
 * Minimal valid `POST /v1/chat/` body that triggers a real chat turn: a
 * fresh global thread (the handler creates it) plus one user text
 * message. No workspace is referenced, so no matter provisioning is
 * needed for the synthetic org.
 */
export const buildChatSmokeBody = (): ChatSmokeBody => ({
  threadId: Bun.randomUUIDv7(),
  sendMode: "rawOverride",
  message: {
    id: Bun.randomUUIDv7(),
    role: "user",
    parts: [{ type: "text", text: "ping" }],
  },
});

const mintSmokeSession = async (
  baseUrl: string,
  secret: string,
): Promise<SmokeSession> => {
  const response = await fetchWithTimeout(`${baseUrl}/smoke/session`, {
    method: "POST",
    headers: { "x-smoke-secret": secret },
    timeoutMs: SMOKE_SESSION_TIMEOUT_MS,
  });
  const evaluated = evaluateHttpCheck({
    name: "POST /smoke/session",
    status: response.status,
    mode: CHECK_MODE.okOnly,
  });
  if (!evaluated.ok) {
    throw new PostDeploySmokeError({
      message:
        `Could not mint a smoke session: ${evaluated.detail}. ` +
        "Verify SMOKE_SESSION_SECRET matches the deployed value and that " +
        "the target environment enables the smoke route.",
    });
  }
  return parseSmokeSession(await response.json());
};

const readAuthenticated = async (
  baseUrl: string,
  path: string,
  cookie: string,
): Promise<EvaluatedCheck> => {
  const response = await fetchWithTimeout(`${baseUrl}${path}`, {
    headers: { cookie },
    timeoutMs: READ_CHECK_TIMEOUT_MS,
  });
  return evaluateHttpCheck({
    name: `GET ${path}`,
    status: response.status,
    mode: CHECK_MODE.okOnly,
  });
};

const readHealth = async (baseUrl: string): Promise<EvaluatedCheck> => {
  const response = await fetchWithTimeout(`${baseUrl}/health`, {
    timeoutMs: READ_CHECK_TIMEOUT_MS,
  });
  return evaluateHealthRevision({
    body: response.ok ? await response.json().catch(() => null) : null,
    expectedCommit: process.env["EXPECTED_COMMIT"],
    status: response.status,
  });
};

const sleep = async (ms: number): Promise<void> =>
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const writeReadinessLog = (message: string): void => {
  process.stdout.write(`[api-readiness] ${message}\n`);
};

const waitForApiRevision = async (baseUrl: string): Promise<void> => {
  const expectedCommit = process.env["EXPECTED_COMMIT"];
  if (!expectedCommit) {
    return;
  }

  const deadline = Date.now() + REVISION_READINESS_TIMEOUT_MS;
  let consecutive = 0;
  let lastDetail = "no readiness samples collected";
  let nextPeriodicLogAt = 0;

  writeReadinessLog(
    `waiting for ${expectedCommit} for up to ${
      REVISION_READINESS_TIMEOUT_MS / 1000
    }s`,
  );

  while (Date.now() < deadline) {
    let check: EvaluatedCheck;
    try {
      // oxlint-disable-next-line no-await-in-loop -- readiness must be sampled sequentially to build a stable streak
      check = await readHealth(baseUrl);
    } catch (error) {
      check = {
        name: "GET /health",
        ok: false,
        detail: `request failed: ${errorMessage(error)}`,
      };
    }

    const now = Date.now();
    consecutive = check.ok ? consecutive + 1 : 0;
    if (check.detail !== lastDetail || now >= nextPeriodicLogAt) {
      writeReadinessLog(
        `${check.ok ? "ready" : "waiting"} (${check.detail}); stable samples ${String(
          consecutive,
        )}/${String(REVISION_READINESS_STABLE_SAMPLES)}`,
      );
      nextPeriodicLogAt = now + REVISION_READINESS_LOG_INTERVAL_MS;
    }
    lastDetail = check.detail;

    if (consecutive >= REVISION_READINESS_STABLE_SAMPLES) {
      writeReadinessLog(`ready after ${String(consecutive)} stable samples`);
      return;
    }

    // oxlint-disable-next-line no-await-in-loop -- sequential poll backoff: wait between readiness samples
    await sleep(REVISION_READINESS_INTERVAL_MS);
  }

  throw new PostDeploySmokeError({
    message:
      `API did not stably serve ${expectedCommit} within ` +
      `${String(REVISION_READINESS_TIMEOUT_MS / 1000)}s. ` +
      `Last sample: ${lastDetail}`,
  });
};

type ReadStreamPrefixOptions = {
  maxBytes?: number;
  timeoutMs?: number;
};

type StreamReader = {
  cancel: () => Promise<unknown>;
  read: () => Promise<{
    done: boolean;
    value?: Uint8Array | undefined;
  }>;
};

type StreamReadResult = Awaited<ReturnType<StreamReader["read"]>>;

const readWithDeadline = async (
  reader: StreamReader,
  deadline: number,
): Promise<StreamReadResult> => {
  const remainingMs = deadline - Date.now();
  if (remainingMs <= 0) {
    throw new PostDeploySmokeError({
      message: "Chat stream did not produce a readable prefix before timeout",
    });
  }

  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timeoutId = setTimeout(() => {
      reject(
        new PostDeploySmokeError({
          message:
            "Chat stream did not produce a readable prefix before timeout",
        }),
      );
      detached(
        reader.cancel().catch(() => undefined),
        "readWithDeadline",
      );
    }, remainingMs);
  });

  try {
    return await Promise.race([reader.read(), timeout]);
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
};

export const readStreamPrefix = async (
  response: Response,
  {
    maxBytes = CHAT_STREAM_PREFIX_BYTES,
    timeoutMs = CHAT_STREAM_READ_TIMEOUT_MS,
  }: ReadStreamPrefixOptions = {},
): Promise<string> => {
  if (!response.body) {
    return "";
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const deadline = Date.now() + timeoutMs;
  let buffered = "";
  try {
    while (buffered.length < maxBytes) {
      // oxlint-disable-next-line no-await-in-loop -- sequential prefix read: each chunk extends the buffer we then scan
      const { done, value } = await readWithDeadline(reader, deadline);
      if (done) {
        break;
      }
      if (value) {
        buffered += decoder.decode(value, { stream: true });
        if (
          streamPrefixHasError(buffered) ||
          streamPrefixHasMeaningfulFrame(buffered)
        ) {
          break;
        }
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return buffered;
};

const sendChat = async (
  baseUrl: string,
  cookie: string,
): Promise<EvaluatedCheck[]> => {
  const response = await fetchWithTimeout(`${baseUrl}/v1/chat/`, {
    method: "POST",
    headers: {
      cookie,
      "content-type": "application/json",
    },
    body: JSON.stringify(buildChatSmokeBody()),
    timeoutMs: CHAT_SEND_TIMEOUT_MS,
  });

  const httpCheck = evaluateHttpCheck({
    name: "POST /v1/chat/",
    status: response.status,
    mode: CHECK_MODE.chatSend,
    body: isSuccess(response.status) ? "" : await response.text(),
  });

  // Only inspect the stream when the request actually streamed (2xx). A
  // non-streaming no-AI response is captured by httpCheck; every other
  // non-2xx status fails there.
  if (!isSuccess(response.status)) {
    return [httpCheck];
  }

  const streamTypeCheck = evaluateChatStreamContentType(
    response.headers.get("content-type"),
  );
  if (!streamTypeCheck.ok) {
    await response.body?.cancel().catch(() => undefined);
    return [httpCheck, streamTypeCheck];
  }

  let streamCheck: EvaluatedCheck;
  try {
    const prefix = await readStreamPrefix(response);
    streamCheck = evaluateChatStreamPrefix(prefix);
  } catch (error) {
    streamCheck = {
      name: "POST /v1/chat/ (stream)",
      ok: false,
      detail: `stream read failed: ${errorMessage(error)}`,
    };
  }
  return [httpCheck, streamTypeCheck, streamCheck];
};

const resolveBaseUrl = (): string => {
  const raw =
    process.argv[2] ??
    process.env["SMOKE_API_URL"] ??
    process.env["E2E_API_URL"];
  if (!raw) {
    throw new PostDeploySmokeError({
      message:
        "Target API base URL is required (pass as the first argument or set " +
        "SMOKE_API_URL / E2E_API_URL), e.g. https://api-staging.stll.app",
    });
  }
  return raw.replace(/\/+$/u, "");
};

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const main = async (): Promise<void> => {
  const baseUrl = resolveBaseUrl();
  const secret = process.env["SMOKE_SESSION_SECRET"];
  if (!secret) {
    throw new PostDeploySmokeError({
      message:
        "SMOKE_SESSION_SECRET is required to authenticate the post-deploy smoke",
    });
  }

  await waitForApiRevision(baseUrl);

  const session = await mintSmokeSession(baseUrl, secret);
  const cookie = sessionCookieHeader(session);

  const checks: EvaluatedCheck[] = [];
  checks.push(await readHealth(baseUrl));
  checks.push(await readAuthenticated(baseUrl, "/v1/chat/threads", cookie));
  checks.push(...(await sendChat(baseUrl, cookie)));

  for (const check of checks) {
    const marker = check.ok ? "ok  " : "FAIL";
    process.stdout.write(`[${marker}] ${check.name}: ${check.detail}\n`);
  }

  if (!allChecksPassed(checks)) {
    const failed = checks
      .filter((check) => !check.ok)
      .map((check) => check.name)
      .join(", ");
    throw new PostDeploySmokeError({
      message: `Post-deploy smoke failed against ${baseUrl}: ${failed}`,
    });
  }

  process.stdout.write(`Post-deploy smoke passed against ${baseUrl}\n`);
};

if (import.meta.main) {
  main().catch((error: unknown) => {
    process.stderr.write(`${errorMessage(error)}\n`);
    process.exit(1);
  });
}
