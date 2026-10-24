import { request } from "@playwright/test";
import { panic } from "better-result";
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { fetchSmokeSessionStorageState } from "../helpers/smoke-session";
import {
  JOURNEY_SEEDED_STORAGE_STATE,
  JOURNEY_STORAGE_STATE,
} from "../playwright.journeys.config";
import {
  JOURNEY_SIGN_IN,
  type JourneySignIn,
  readJourneyEdgeHeaders,
  readJourneySignIn,
  readJourneyWebUrl,
} from "./env";

const signInWithReviewAccount = async ({
  email,
  password,
}: Extract<JourneySignIn, { type: typeof JOURNEY_SIGN_IN.reviewAccount }>) => {
  const context = await request.newContext({
    baseURL: readJourneyWebUrl(),
    extraHTTPHeaders: readJourneyEdgeHeaders(),
  });
  const response = await context.post("/api/auth/sign-in/email", {
    data: { email, password },
    failOnStatusCode: false,
    timeout: 15_000,
  });
  if (!response.ok()) {
    await context.dispose();
    throw new Error(
      `POST /api/auth/sign-in/email -> ${String(response.status())}`,
    );
  }
  await context.storageState({ path: JOURNEY_STORAGE_STATE });
  await context.dispose();
};

const globalSetup = async (): Promise<void> => {
  const signIn = readJourneySignIn();
  await mkdir(path.dirname(JOURNEY_STORAGE_STATE), { recursive: true });
  switch (signIn.type) {
    case JOURNEY_SIGN_IN.seeded:
      await copyFile(JOURNEY_SEEDED_STORAGE_STATE, JOURNEY_STORAGE_STATE);
      return;
    case JOURNEY_SIGN_IN.smokeSession: {
      const storageState = await fetchSmokeSessionStorageState({
        headers: readJourneyEdgeHeaders(),
        secret: signIn.secret,
        sessionUrl: signIn.sessionUrl,
        webUrl: readJourneyWebUrl(),
      });
      await writeFile(JOURNEY_STORAGE_STATE, JSON.stringify(storageState));
      return;
    }
    case JOURNEY_SIGN_IN.reviewAccount:
      await signInWithReviewAccount(signIn);
      return;
    default:
      signIn satisfies never;
      return panic("Unhandled journey sign-in");
  }
};

export default globalSetup;
