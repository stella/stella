import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { STAGING_STORAGE_STATE } from "../playwright.staging.config";

type SmokeSession = {
  cookieName: string;
  cookieValue: string;
  expiresAt: string;
};

const API_URL = process.env["E2E_API_URL"] ?? "https://api-staging.stll.app";

const READINESS_ATTEMPTS = 60;
const READINESS_INTERVAL_MS = 5_000;

const sleep = (ms: number) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

// Block until the deployed revision is actually serving. verify-staging
// fires the moment the promote returns, while ECS is still rolling the
// new task in; requests in that window hang or reset and the old task
// keeps answering with the previous commit. Polling /health until it
// reports the expected commit removes that race (and any request errors
// during rollover are just retried). With no expected commit (local
// runs) a single 200 is enough.
const waitForDeployedRevision = async (): Promise<void> => {
  const expectedCommit = process.env["EXPECTED_COMMIT"];
  for (let attempt = 0; attempt < READINESS_ATTEMPTS; attempt++) {
    try {
      const response = await fetch(`${API_URL}/health`, {
        signal: AbortSignal.timeout(10_000),
      });
      if (response.ok) {
        const { commit } = (await response.json()) as { commit?: string };
        if (!expectedCommit || commit === expectedCommit) {
          return;
        }
      }
    } catch {
      // Connection reset/timeout during rollover; fall through to retry.
    }
    await sleep(READINESS_INTERVAL_MS);
  }
  throw new Error(
    `Staging did not serve ${expectedCommit ?? "a healthy revision"} within ` +
      `${(READINESS_ATTEMPTS * READINESS_INTERVAL_MS) / 1000}s`,
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
