import { setTimeout as delay } from "node:timers/promises";
import * as v from "valibot";

import {
  JOURNEY_PREREQUISITE_STATE,
  JOURNEY_PREREQUISITES_PATH,
  journeyPrerequisitesForwardSchema,
  journeyPrerequisitesReportSchema,
  SCHEDULED_JOB_MAX_RUNTIME_MS,
} from "@stll/api-contract/journey-prerequisites";
import type {
  JourneyPrerequisiteId,
  JourneyPrerequisiteReport,
} from "@stll/api-contract/journey-prerequisites";

import {
  JOURNEY_SIGN_IN,
  readJourneyEdgeHeaders,
  readJourneySignIn,
} from "../journeys/env";
import { E2E_API_ORIGIN } from "./api";

/**
 * The brought-forward run may use its whole budget (a slow external publisher
 * is not a failure), plus a minute for the scheduler to claim it.
 */
export const JOURNEY_PREREQUISITE_TIMEOUT_MS =
  SCHEDULED_JOB_MAX_RUNTIME_MS + 60_000;
const JOURNEY_PREREQUISITE_POLL_MS = 5000;
const REQUEST_TIMEOUT_MS = 15_000;

type PrerequisiteFetch = (
  input: URL,
  init: { method: "GET" | "POST"; headers: Record<string, string> },
) => Promise<Response>;

export type EstablishJourneyPrerequisitesOptions = {
  apiUrl: string;
  /** Edge headers the deployment requires on every request. */
  headers: Record<string, string>;
  journey: JourneyPrerequisiteId;
  secret: string;
  fetcher?: PrerequisiteFetch;
  intervalMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
};

const defaultFetch: PrerequisiteFetch = async (input, init) =>
  await fetch(input, {
    ...init,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

const readJson = async <TSchema extends v.GenericSchema>(
  response: Response,
  schema: TSchema,
  label: string,
): Promise<v.InferOutput<TSchema>> => {
  if (!response.ok) {
    throw new Error(
      `${label} -> ${String(response.status)}: ${await response.text()}`,
    );
  }
  const parsed = v.safeParse(schema, await response.json());
  if (!parsed.success) {
    throw new Error(`${label} answered an unexpected shape`);
  }
  return parsed.output;
};

type BlockingReport = Exclude<JourneyPrerequisiteReport, { state: "ready" }>;

/** The reports in `state`; the state decides, the detail only explains. */
const reportsIn = (
  reports: readonly JourneyPrerequisiteReport[],
  state: BlockingReport["state"],
): BlockingReport[] =>
  reports.flatMap((report) =>
    report.state !== JOURNEY_PREREQUISITE_STATE.ready && report.state === state
      ? [report]
      : [],
  );

const describeReports = (reports: readonly BlockingReport[]) =>
  reports
    .map(({ jobId, detail }) => (detail === "" ? jobId : detail))
    .join("; ");

/**
 * Brings a deployed journey's scheduled jobs forward and waits until each has
 * run and established what the journey reads. Throws with the job's own
 * error or failure code when one cannot, and with what is still pending when
 * the wait runs out, so the journey never judges data a job has not refreshed.
 */
export const establishJourneyPrerequisites = async ({
  apiUrl,
  headers,
  journey,
  secret,
  fetcher = defaultFetch,
  intervalMs = JOURNEY_PREREQUISITE_POLL_MS,
  now = Date.now,
  sleep = async (ms) => await delay(ms),
  timeoutMs = JOURNEY_PREREQUISITE_TIMEOUT_MS,
}: EstablishJourneyPrerequisitesOptions): Promise<void> => {
  const requestHeaders = { ...headers, "x-smoke-secret": secret };
  const forwardUrl = new URL(JOURNEY_PREREQUISITES_PATH, apiUrl);
  forwardUrl.searchParams.set("journey", journey);
  const { dueAt } = await readJson(
    await fetcher(forwardUrl, { method: "POST", headers: requestHeaders }),
    journeyPrerequisitesForwardSchema,
    `POST ${JOURNEY_PREREQUISITES_PATH}`,
  );
  const reportUrl = new URL(forwardUrl);
  reportUrl.searchParams.set("since", dueAt);
  const deadline = now() + timeoutMs;

  const poll = async (): Promise<void> => {
    const { prerequisites } = await readJson(
      await fetcher(reportUrl, { method: "GET", headers: requestHeaders }),
      journeyPrerequisitesReportSchema,
      `GET ${JOURNEY_PREREQUISITES_PATH}`,
    );
    const failed = reportsIn(prerequisites, JOURNEY_PREREQUISITE_STATE.failed);
    if (failed.length > 0) {
      throw new Error(
        `The ${journey} journey's scheduled jobs failed: ${describeReports(failed)}`,
      );
    }
    const pending = reportsIn(
      prerequisites,
      JOURNEY_PREREQUISITE_STATE.pending,
    );
    if (pending.length === 0) {
      return;
    }
    if (now() >= deadline) {
      throw new Error(
        `The ${journey} journey's scheduled jobs did not run within ${String(timeoutMs / 1000)} s: ${describeReports(pending)}`,
      );
    }
    await sleep(intervalMs);
    await poll();
  };
  await poll();
};

/**
 * A journey reaching a deployment through the smoke session is on staging,
 * which runs only for release proofs, so it brings its jobs forward first.
 * Any other sign-in reaches a deployment whose scheduler runs all the time,
 * and the journey judges it as it is.
 */
export const establishDeployedJourneyPrerequisites = async (
  journey: JourneyPrerequisiteId,
): Promise<void> => {
  const signIn = readJourneySignIn();
  if (signIn.type !== JOURNEY_SIGN_IN.smokeSession) {
    return;
  }
  await establishJourneyPrerequisites({
    apiUrl: E2E_API_ORIGIN,
    headers: readJourneyEdgeHeaders(),
    journey,
    secret: signIn.secret,
  });
};
