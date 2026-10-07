import type { EventEmitter } from "node:events";
import https, { type RequestOptions } from "node:https";

export const SOURCES = [
  "eu",
  "un",
  "cz",
  "us-sdn",
  "us-non-sdn",
  "uk",
  "ch",
] as const;
const STATUSES = ["clear", "possible-match", "unavailable"] as const;
const MAX_BYTES = 1024 * 1024;
const TIMEOUT_MS = 15_000;
const TARGET_URL = "https://my.stll.app/api/v1/sanctions/search";
export const POSITIVE_CONTROL = {
  subject: { type: "organization", name: "Voice of Europe" },
  expectedSources: ["eu", "cz"],
} as const satisfies {
  subject: { type: "organization"; name: string };
  expectedSources: readonly (typeof SOURCES)[number][];
};
const SUBJECT = JSON.stringify({ subject: POSITIVE_CONTROL.subject });

type FailureCode =
  | "positive-control-missed"
  | "invalid-response"
  | "invalid-list"
  | "list-unavailable"
  | "unexpected-unavailable"
  | "invalid-edition"
  | "incomplete-coverage"
  | "aggregate-mismatch"
  | "invalid-target"
  | "response-too-large"
  | "response-aborted"
  | "http-status"
  | "invalid-json"
  | "deadline-exceeded";

export class CanaryFailureError extends Error {
  readonly code: FailureCode;
  constructor(code: FailureCode) {
    super(code);
    this.code = code;
    this.name = "CanaryFailureError";
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isStatus = (value: unknown): value is (typeof STATUSES)[number] =>
  STATUSES.some((status) => status === value);
const isSource = (value: unknown): value is (typeof SOURCES)[number] =>
  SOURCES.some((source) => source === value);
const isEditionField = (value: unknown) =>
  value === null || (typeof value === "string" && value.length > 0);

export const validateScreening = (body: unknown): void => {
  if (!isRecord(body) || !isStatus(body.status) || !Array.isArray(body.lists)) {
    throw new CanaryFailureError("invalid-response");
  }
  const seen = new Set<string>();
  const matched = new Set<string>();
  let published = 0;
  let aggregate: (typeof STATUSES)[number] = "clear";
  for (const entry of body.lists) {
    const list: unknown = entry;
    if (
      !isRecord(list) ||
      !isSource(list.source) ||
      seen.has(list.source) ||
      !isStatus(list.status) ||
      !isEditionField(list.editionId) ||
      !isEditionField(list.publishedAt)
    ) {
      throw new CanaryFailureError("invalid-list");
    }
    seen.add(list.source);
    if (
      list.reason === "load-failed" ||
      (list.status === "unavailable" &&
        (list.editionId !== null || list.publishedAt !== null))
    ) {
      throw new CanaryFailureError("list-unavailable");
    }
    if (
      list.status === "unavailable" &&
      list.reason !== "not-loaded" &&
      list.reason !== "access-denied"
    ) {
      throw new CanaryFailureError("unexpected-unavailable");
    }
    if (
      list.status !== "unavailable" &&
      (list.reason !== null ||
        list.editionId === null ||
        list.publishedAt === null)
    ) {
      throw new CanaryFailureError("invalid-edition");
    }
    if (list.editionId !== null) {
      published += 1;
    }
    if (list.status === "possible-match") {
      matched.add(list.source);
      aggregate = "possible-match";
    } else if (
      list.status === "unavailable" &&
      aggregate !== "possible-match"
    ) {
      aggregate = "unavailable";
    }
  }
  if (seen.size !== SOURCES.length || published === 0) {
    throw new CanaryFailureError("incomplete-coverage");
  }
  if (body.status !== aggregate) {
    throw new CanaryFailureError("aggregate-mismatch");
  }
  if (
    !POSITIVE_CONTROL.expectedSources.every((source) => matched.has(source))
  ) {
    throw new CanaryFailureError("positive-control-missed");
  }
};

export type CanaryResponse = {
  statusCode?: number;
} & Pick<EventEmitter, "on">;
export type CanaryRequest = {
  destroy: (error: Error) => void;
  end: (payload: string) => void;
} & Pick<EventEmitter, "on">;
export type RequestHttps = (
  url: URL,
  options: RequestOptions,
  callback: (response: CanaryResponse) => void,
) => CanaryRequest;

type ProbeOptions = {
  requestHttps?: RequestHttps;
  deadlineMs?: number;
};
export const probe = (
  url: string,
  { requestHttps = https.request, deadlineMs = TIMEOUT_MS }: ProbeOptions = {},
): Promise<void> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return new Promise<void>((resolve, reject) => {
    let target: URL;
    try {
      target = new URL(url);
    } catch {
      reject(new CanaryFailureError("invalid-target"));
      return;
    }
    if (target.protocol !== "https:" || target.username || target.password) {
      reject(new CanaryFailureError("invalid-target"));
      return;
    }
    const request = requestHttps(
      target,
      {
        method: "POST",
        agent: false,
        headers: {
          "User-Agent": "StellaSanctionsCanary/1.0",
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(SUBJECT),
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        let bytes = 0;
        response.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > MAX_BYTES) {
            request.destroy(new CanaryFailureError("response-too-large"));
            return;
          }
          chunks.push(chunk);
        });
        response.on("error", reject);
        response.on("aborted", () =>
          reject(new CanaryFailureError("response-aborted")),
        );
        response.on("end", () => {
          if (response.statusCode !== 200) {
            reject(new CanaryFailureError("http-status"));
            return;
          }
          let body: unknown;
          try {
            body = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
          } catch {
            reject(new CanaryFailureError("invalid-json"));
            return;
          }
          try {
            validateScreening(body);
            resolve();
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    // Covers TLS setup, response headers and the entire response body.
    timer = setTimeout(
      () => request.destroy(new CanaryFailureError("deadline-exceeded")),
      deadlineMs,
    );
    request.on("error", reject);
    request.on("close", () => clearTimeout(timer));
    request.end(SUBJECT);
  }).finally(() => clearTimeout(timer));
};

type RunCanaryOptions = {
  targetUrl?: string;
  probe?: (url: string) => Promise<void>;
  log?: (message: string) => void;
};
export const runCanary = async ({
  targetUrl = TARGET_URL,
  probe: check = probe,
  log = console.log,
}: RunCanaryOptions = {}): Promise<0 | 1> => {
  try {
    await check(targetUrl);
    log("public sanctions canary passed");
    return 0;
  } catch (error) {
    // Only owned failure codes enter logs; response data and transport messages do not.
    log(
      `public sanctions canary failed: ${error instanceof CanaryFailureError ? error.code : "transport-failed"}`,
    );
    return 1;
  }
};

if (import.meta.main) {
  process.exitCode = await runCanary();
}
