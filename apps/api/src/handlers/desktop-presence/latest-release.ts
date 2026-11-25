/**
 * The newest stella desktop release, as the desktop's own updater feed names
 * it.
 *
 * The feed is the public `latest.json` the desktop updater reads; the release
 * job advances it only once the signed packages are on the downloads CDN, so
 * a version read here is one a desktop can install. The API only passes the
 * version on: a desktop that hears of it runs its normal check against the
 * same feed and verifies the package's signature itself. A relay that is
 * wrong or unreachable can delay an update, never cause one.
 */

import { Result } from "better-result";
import * as v from "valibot";

import { desktopVersionSchema } from "@stll/api-contract/desktop-presence";
import { Temporal } from "@stll/time";

import { safeOutboundFetchBytes } from "@/api/lib/auth/authorized-outbound-fetch";
import type { ThirdPartyOutboundPermit } from "@/api/lib/auth/third-party-outbound-permit";
import {
  type ReadOutcome,
  readOutcomeOfStatus,
  readPresent,
  readUnavailable,
} from "@/api/lib/errors/read-outcome";
import type {
  SafeOutboundFetchError,
  SafeOutboundFetchResponse,
} from "@/api/lib/safe-outbound-fetch";

import { MOBILE_UPDATES_CDN_ORIGIN } from "../mobile-updates/relay";

/** The feed `apps/desktop/src-tauri/tauri.conf.json` points the updater at. */
export const DESKTOP_RELEASE_FEED_URL = `${MOBILE_UPDATES_CDN_ORIGIN}/desktop/prod/latest.json`;

const FEED_TIMEOUT_MS = 5000;
/** The feed lists a version, notes and a few signed package links. */
const FEED_MAX_BYTES = 64 * 1024;
/** How long a read version answers every desktop before the feed is read again. */
const FRESH_MS = 5 * 60 * 1000;
/** How long a feed that could not be read answers so before it is tried again. */
const RETRY_MS = 60 * 1000;

const feedSchema = v.object({ version: desktopVersionSchema });

/** Reads the feed under the caller's permit. */
export type FeedFetch = () => Promise<
  Result<SafeOutboundFetchResponse, SafeOutboundFetchError>
>;

export const feedFetch =
  (permit: ThirdPartyOutboundPermit): FeedFetch =>
  async () =>
    await safeOutboundFetchBytes({
      maxBytes: FEED_MAX_BYTES,
      permit,
      timeout: { type: "headers", ms: FEED_TIMEOUT_MS },
      url: DESKTOP_RELEASE_FEED_URL,
    });

/** The version the feed names; anything else is why it could not be read. */
const readFeedVersion = async (
  fetchFeed: FeedFetch,
): Promise<ReadOutcome<string>> => {
  const fetched = await fetchFeed();
  if (Result.isError(fetched)) {
    return readUnavailable({ kind: "thrown", error: fetched.error });
  }
  const response = fetched.value;
  if (!response.ok) {
    const outcome = readOutcomeOfStatus(response.status, "document");
    return outcome.type === "present"
      ? readUnavailable({ kind: "status", status: response.status })
      : outcome;
  }
  const parsed = v.safeParse(
    v.pipe(v.string(), v.parseJson(), feedSchema),
    new TextDecoder().decode(response.body),
  );
  return parsed.success
    ? readPresent(parsed.output.version)
    : readUnavailable({ kind: "empty-body", status: response.status });
};

type Cached = {
  readonly outcome: ReadOutcome<string>;
  readonly until: number;
};

/**
 * The newest release, read at most once per `FRESH_MS` for every desktop the
 * API answers (once per `RETRY_MS` while the feed cannot be read). Concurrent
 * callers share one read.
 */
export const createLatestDesktopRelease = (
  now: () => number = () => Temporal.Now.instant().epochMilliseconds,
) => {
  let cached: Cached | undefined;
  let reading: Promise<ReadOutcome<string>> | undefined;
  const read = async (fetchFeed: FeedFetch) => {
    try {
      const outcome = await readFeedVersion(fetchFeed);
      cached = {
        outcome,
        until: now() + (outcome.type === "present" ? FRESH_MS : RETRY_MS),
      };
      return outcome;
    } finally {
      reading = undefined;
    }
  };
  return async (fetchFeed: FeedFetch): Promise<ReadOutcome<string>> => {
    if (cached && now() < cached.until) {
      return cached.outcome;
    }
    reading ??= read(fetchFeed);
    return await reading;
  };
};

export const latestDesktopRelease = createLatestDesktopRelease();
