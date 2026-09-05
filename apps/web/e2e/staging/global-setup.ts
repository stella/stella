import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  EDGE_HEADERS,
  STAGING_STORAGE_STATE,
} from "../playwright.staging.config";

type SmokeSession = {
  cookieName: string;
  cookieValue: string;
  expiresAt: string;
};

const API_URL = process.env["E2E_API_URL"] ?? "https://api-staging.stll.app";
const WEB_URL = process.env["E2E_WEB_URL"] ?? "https://staging.stll.app";

const READINESS_TIMEOUT_MS = 1_200_000;
const READINESS_INTERVAL_MS = 5000;
const READINESS_LOG_INTERVAL_MS = 30_000;
// Require several consecutive expected-commit samples before proceeding:
// during rollover the ALB serves old and new tasks side by side, so a
// single new-commit hit does not mean later browser traffic avoids the
// draining task. Consecutive matches signal the old task has drained.
const READINESS_STABLE_SAMPLES = 3;

const sleep = async (ms: number) =>
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

type Origin = {
  label: string;
  // Returns true when this origin is serving the expected revision.
  // The web origin's version.json may be absent on the revision being
  // replaced (it predates this marker), so a missing marker counts as
  // ready: the API gate covers the dominant rollover race regardless.
  sample: (expectedCommit: string | undefined) => Promise<ReadinessSample>;
};

type VersionProbe =
  | {
      type: "ok";
      commit: string | null;
    }
  | {
      type: "missing-marker";
    }
  | {
      type: "http-error";
      status: number;
    }
  | {
      type: "invalid-json";
    }
  | {
      message: string;
      type: "network-error";
    };

type ReadinessSample = {
  detail: string;
  label: string;
  ready: boolean;
};

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const fetchCommit = async (url: string): Promise<VersionProbe> => {
  try {
    const response = await fetch(url, {
      headers: EDGE_HEADERS,
      signal: AbortSignal.timeout(10_000),
    });
    if (response.status === 404) {
      return { type: "missing-marker" };
    }
    if (!response.ok) {
      return { type: "http-error", status: response.status };
    }
    const body: unknown = await response.json().catch(() => null);
    if (!isObject(body)) {
      return { type: "invalid-json" };
    }
    const commit = body["commit"];
    if (typeof commit === "string") {
      return { type: "ok", commit };
    }
    if (commit === undefined || commit === null) {
      return { type: "ok", commit: null };
    }
    return { type: "invalid-json" };
  } catch {
    // Connection reset/timeout during rollover; treated as not-ready.
    return { type: "network-error", message: "request failed or timed out" };
  }
};

const sampleRevision = async ({
  allowMissingMarker,
  expectedCommit,
  label,
  url,
}: {
  allowMissingMarker: boolean;
  expectedCommit: string | undefined;
  label: string;
  url: string;
}): Promise<ReadinessSample> => {
  const probe = await fetchCommit(url);
  if (probe.type === "http-error") {
    return {
      detail: `HTTP ${String(probe.status)}`,
      label,
      ready: false,
    };
  }
  if (probe.type === "invalid-json") {
    return { detail: "invalid JSON body", label, ready: false };
  }
  if (probe.type === "network-error") {
    return { detail: probe.message, label, ready: false };
  }
  if (probe.type === "missing-marker") {
    return {
      detail: allowMissingMarker
        ? "version marker missing; accepted"
        : "version marker missing",
      label,
      ready: allowMissingMarker,
    };
  }

  if (!expectedCommit) {
    return {
      detail: probe.commit ? `healthy commit ${probe.commit}` : "healthy",
      label,
      ready: true,
    };
  }

  if (probe.commit === expectedCommit) {
    return { detail: `commit ${probe.commit}`, label, ready: true };
  }

  return {
    detail: probe.commit
      ? `stale commit ${probe.commit}`
      : "commit missing from response",
    label,
    ready: false,
  };
};

const ORIGINS: Origin[] = [
  {
    label: "api",
    sample: async (expectedCommit) =>
      await sampleRevision({
        allowMissingMarker: false,
        expectedCommit,
        label: "api",
        url: `${API_URL}/ready`,
      }),
  },
  {
    label: "web",
    sample: async (expectedCommit) =>
      await sampleRevision({
        allowMissingMarker: true,
        expectedCommit,
        label: "web",
        url: `${WEB_URL}/version.json`,
      }),
  },
];

const formatReadinessSamples = (samples: ReadinessSample[]): string =>
  samples
    .map(
      (sample) =>
        `${sample.label}: ${sample.ready ? "ready" : "waiting"} (${sample.detail})`,
    )
    .join("; ");

const writeReadinessLog = (message: string): void => {
  process.stdout.write(`[staging-readiness] ${message}\n`);
};

// Block until both the API and the web origin stably serve the deployed
// revision. Requests during a rollout may still reach the previous bundle.
// Any non-ready sample on either origin resets the stable-readiness streak.
// With no expected commit (local runs), any healthy response counts.
const waitForDeployedRevision = async (): Promise<void> => {
  const expectedCommit = process.env["EXPECTED_COMMIT"];
  const deadline = Date.now() + READINESS_TIMEOUT_MS;
  let consecutive = 0;
  let lastSummary = "no readiness samples collected";
  let nextPeriodicLogAt = 0;

  writeReadinessLog(
    `waiting for ${expectedCommit ?? "healthy staging"} for up to ${
      READINESS_TIMEOUT_MS / 1000
    }s`,
  );

  while (Date.now() < deadline) {
    const samples = await Promise.all(
      ORIGINS.map(async (origin) => await origin.sample(expectedCommit)),
    );
    const summary = formatReadinessSamples(samples);
    const now = Date.now();
    consecutive = samples.every((sample) => sample.ready) ? consecutive + 1 : 0;
    if (summary !== lastSummary || now >= nextPeriodicLogAt) {
      writeReadinessLog(
        `${summary}; stable samples ${String(consecutive)}/${String(
          READINESS_STABLE_SAMPLES,
        )}`,
      );
      nextPeriodicLogAt = now + READINESS_LOG_INTERVAL_MS;
    }
    lastSummary = summary;

    if (consecutive >= READINESS_STABLE_SAMPLES) {
      writeReadinessLog(`ready after ${String(consecutive)} stable samples`);
      return;
    }
    await sleep(READINESS_INTERVAL_MS);
  }

  throw new Error(
    `Staging did not stably serve ${expectedCommit ?? "a healthy revision"} ` +
      `within ${READINESS_TIMEOUT_MS / 1000}s. Last sample: ${lastSummary}`,
  );
};

const globalSetup = async (): Promise<void> => {
  const secret = process.env["SMOKE_SESSION_SECRET"];
  if (!secret) {
    throw new Error("SMOKE_SESSION_SECRET is required for the staging smoke");
  }

  await waitForDeployedRevision();

  const response = await fetch(`${API_URL}/smoke/session`, {
    method: "POST",
    headers: { "x-smoke-secret": secret, ...EDGE_HEADERS },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    throw new Error(`POST /smoke/session -> ${String(response.status)}`);
  }
  const session = (await response.json()) as SmokeSession;

  // Browser sessions are host-only on the web origin. The API hostname stays
  // public for non-browser clients, but the SPA never sends its cookie there.
  const storageState = {
    cookies: [
      {
        name: session.cookieName,
        value: session.cookieValue,
        domain: new URL(WEB_URL).hostname,
        path: "/",
        expires: Math.floor(new Date(session.expiresAt).getTime() / 1000),
        httpOnly: true,
        secure: true,
        sameSite: "Lax" as const,
      },
    ],
    origins: [],
  };

  mkdirSync(path.dirname(STAGING_STORAGE_STATE), { recursive: true });
  writeFileSync(STAGING_STORAGE_STATE, JSON.stringify(storageState, null, 2));
};

export default globalSetup;
