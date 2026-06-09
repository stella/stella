import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { STAGING_STORAGE_STATE } from "../playwright.staging.config";

type SmokeSession = {
  cookieName: string;
  cookieValue: string;
  expiresAt: string;
};

const API_URL = process.env["E2E_API_URL"] ?? "https://api-staging.stll.app";

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

// Block until the deployed revision is stably serving. verify-staging
// fires the moment the promote returns, while ECS is still rolling the
// new task in; requests in that window hang or reset and the old task
// keeps answering with the previous commit, which renders a blank page.
// Time-bounded so a hanging endpoint can't exceed the budget; request
// errors during rollover reset the streak. With no expected commit
// (local runs) any healthy 200 counts.
const waitForDeployedRevision = async (): Promise<void> => {
  const expectedCommit = process.env["EXPECTED_COMMIT"];
  const deadline = Date.now() + READINESS_TIMEOUT_MS;
  let consecutive = 0;

  while (Date.now() < deadline) {
    let healthy = false;
    try {
      const response = await fetch(`${API_URL}/health`, {
        signal: AbortSignal.timeout(10_000),
      });
      if (response.ok) {
        const { commit } = (await response.json()) as { commit?: string };
        healthy = !expectedCommit || commit === expectedCommit;
      }
    } catch {
      // Connection reset/timeout during rollover; treated as not-ready.
    }

    consecutive = healthy ? consecutive + 1 : 0;
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
