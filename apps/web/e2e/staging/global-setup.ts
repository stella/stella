import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { STAGING_STORAGE_STATE } from "../playwright.staging.config";

type SmokeSession = {
  cookieName: string;
  cookieValue: string;
  expiresAt: string;
};

const API_URL = process.env["E2E_API_URL"] ?? "https://api-staging.stll.app";

const globalSetup = async (): Promise<void> => {
  const secret = process.env["SMOKE_SESSION_SECRET"];
  if (!secret) {
    throw new Error("SMOKE_SESSION_SECRET is required for the staging smoke");
  }

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
