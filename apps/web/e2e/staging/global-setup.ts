import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { STAGING_STORAGE_STATE } from "../playwright.staging.config";

type SmokeSession = {
  cookieName: string;
  cookieValue: string;
  expiresAt: string;
};

const API_URL = process.env["E2E_API_URL"] ?? "https://api-staging.stll.app";
const WEB_URL = process.env["E2E_WEB_URL"] ?? "https://staging.stll.app";

const READINESS_TIMEOUT_MS = 300_000;
const READINESS_INTERVAL_MS = 5000;
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
  isReady: (expectedCommit: string | undefined) => Promise<boolean>;
};

const fetchCommit = async (url: string): Promise<string | null | undefined> => {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (response.status === 404) {
      return null;
    }
    if (!response.ok) {
      return undefined;
    }
    const { commit } = (await response.json()) as { commit?: string };
    return commit;
  } catch {
    // Connection reset/timeout during rollover; treated as not-ready.
    return undefined;
  }
};

const ORIGINS: Origin[] = [
  {
    label: "api",
    isReady: async (expectedCommit) => {
      const commit = await fetchCommit(`${API_URL}/health`);
      if (commit === undefined) {
        return false;
      }
      return !expectedCommit || commit === expectedCommit;
    },
  },
  {
    label: "web",
    isReady: async (expectedCommit) => {
      const commit = await fetchCommit(`${WEB_URL}/version.json`);
      if (commit === undefined) {
        return false;
      }
      return !expectedCommit || commit === null || commit === expectedCommit;
    },
  },
];

// Block until both the API and the web origin stably serve the deployed
// revision. verify-staging fires the moment the promote returns, while
// ECS is still rolling the new task in and the CDN may still front the
// previous bundle; requests in that window render a blank page. Time-
// bounded so a hanging endpoint can't exceed the budget; any non-ready
// sample on either origin resets the streak. With no expected commit
// (local runs) any healthy response counts.
const waitForDeployedRevision = async (): Promise<void> => {
  const expectedCommit = process.env["EXPECTED_COMMIT"];
  const deadline = Date.now() + READINESS_TIMEOUT_MS;
  let consecutive = 0;

  while (Date.now() < deadline) {
    const readiness = await Promise.all(
      ORIGINS.map(async (origin) => await origin.isReady(expectedCommit)),
    );
    consecutive = readiness.every(Boolean) ? consecutive + 1 : 0;
    if (consecutive >= READINESS_STABLE_SAMPLES) {
      return;
    }
    await sleep(READINESS_INTERVAL_MS);
  }

  throw new Error(
    `Staging did not stably serve ${expectedCommit ?? "a healthy revision"} ` +
      `within ${READINESS_TIMEOUT_MS / 1000}s`,
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
    headers: { "x-smoke-secret": secret },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    throw new Error(`POST /smoke/session -> ${String(response.status)}`);
  }
  const session = (await response.json()) as SmokeSession;

  // The session cookie is host-only on the API origin (better-auth
  // runs on the API host; no cross-subdomain cookie config). The
  // SPA sends it via credentialed cross-origin fetches, which needs
  // SameSite=None.
  const storageState = {
    cookies: [
      {
        name: session.cookieName,
        value: session.cookieValue,
        domain: new URL(API_URL).hostname,
        path: "/",
        expires: Math.floor(new Date(session.expiresAt).getTime() / 1000),
        httpOnly: true,
        secure: true,
        sameSite: "None" as const,
      },
    ],
    origins: [],
  };

  mkdirSync(dirname(STAGING_STORAGE_STATE), { recursive: true });
  writeFileSync(STAGING_STORAGE_STATE, JSON.stringify(storageState, null, 2));
};

export default globalSetup;
