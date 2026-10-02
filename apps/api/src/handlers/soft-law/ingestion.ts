import { panic, Result } from "better-result";

import type { ScopedDb } from "@/api/db/safe-db";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import {
  writeRawSourcePayload,
  RAW_SOURCE_FAMILY,
} from "@/api/lib/legal-search/raw-source-storage";
import type { WriteRawSourcePayload } from "@/api/lib/legal-search/raw-source-storage";
import type { SoftLawFetch } from "@/api/lib/legal-search/soft-law-access-types";
import { SoftLawBlockedError } from "@/api/lib/legal-search/soft-law-access-types";
import {
  softLawIdentityKey,
  softLawContentHash,
} from "@/api/lib/legal-search/soft-law-fingerprint";
import { createSoftLawIngestionStore } from "@/api/lib/legal-search/soft-law-ingestion-store";
import type {
  SoftLawObservation,
  SoftLawAttempt,
} from "@/api/lib/legal-search/soft-law-ingestion-store";
import {
  SoftLawIngestionError,
  SoftLawItemError,
  SoftLawListingIncompleteError,
  SOFT_LAW_BATCH_LIMIT,
} from "@/api/lib/legal-search/soft-law-types";
import type {
  SoftLawSourceAdapter,
  SoftLawEntry,
  SoftLawDocumentInput,
} from "@/api/lib/legal-search/soft-law-types";

import { createSoftLawFetch } from "./publisher-access";

const PAGE_BUDGET = 20;
const PAGE_RAW_BYTE_LIMIT = 64 * 1024 * 1024;
const DOCUMENT_RAW_PART_LIMIT = 20;
const ITEM_ATTEMPT_LIMIT = 3;

type RunSoftLawIngestionOptions = {
  sourceId: SafeId<"softLawSource">;
  adapter: SoftLawSourceAdapter;
  scopedDb: ScopedDb;
  signal: AbortSignal;
  writeRaw?: WriteRawSourcePayload;
  accessDependencies?: Pick<
    Parameters<typeof createSoftLawFetch>[0],
    "request" | "reserve" | "now"
  >;
};
export type SoftLawRunResult =
  | { status: "complete" | "paused" | "busy" }
  | { status: "paused"; reason: "deferred_window" }
  | { status: "blocked"; reason: "forbidden" | "rate_limited" | "challenge" }
  | {
      status: "listing_incomplete";
      seen: number;
      baseline: number;
      expectedTotal: number | null;
    }
  | { status: "failed"; error: unknown };

const assertPublisherAvailable = (fetch: SoftLawFetch) => {
  if (fetch.getLeaseState() === "lost") {
    return Result.err(
      new SoftLawIngestionError({ message: "Ingestion lease was lost" }),
    );
  }
  const reason = fetch.getBlockReason();
  if (reason) {
    return Result.err(
      new SoftLawBlockedError({
        message: "Publisher blocked this source",
        reason,
      }),
    );
  }
  if (fetch.getWindowState() === "deferred_window") {
    return Result.err(
      new SoftLawIngestionError({ message: "Publisher window is closed" }),
    );
  }
  return Result.ok();
};
type PrepareSoftLawPageOptions = {
  entries: readonly SoftLawEntry[];
  store: ReturnType<typeof createSoftLawIngestionStore>;
  adapter: SoftLawSourceAdapter;
  sourceId: SafeId<"softLawSource">;
  runId: string;
  signal: AbortSignal;
  fetch: SoftLawFetch;
  writeRaw: WriteRawSourcePayload;
};
type FetchedSoftLawItem = {
  entry: SoftLawEntry;
  input: SoftLawDocumentInput;
  identityKey: string;
  contentHash: string;
  count: number;
  rawByteLength: number;
};
type FetchSoftLawItemOptions = Pick<
  PrepareSoftLawPageOptions,
  "adapter" | "signal" | "fetch"
> & { entry: SoftLawEntry; count: number; maxRawBytes: number };
const fetchSoftLawItem = async ({
  entry,
  adapter,
  signal,
  fetch,
  count,
  maxRawBytes,
}: FetchSoftLawItemOptions) => {
  const fetched = await adapter.fetchDocument(entry, { signal, fetch });
  if (fetched.status === "error") {
    return fetched;
  }
  const input = fetched.value;
  const identity = softLawIdentityKey(adapter.authority, input.metadata);
  if (identity.status === "error") {
    return identity;
  }
  const identityKey = identity.value;
  if (
    !input.raw.length ||
    input.raw.length > DOCUMENT_RAW_PART_LIMIT ||
    new Set(input.raw.map((part) => part.role)).size !== input.raw.length
  ) {
    return Result.err(
      new SoftLawItemError({
        message: "Document raw parts are missing or ambiguous",
        tag: "invalid_document",
      }),
    );
  }
  const rawByteLength = input.raw.reduce(
    (total, part) => total + part.bytes.byteLength,
    0,
  );
  if (rawByteLength > maxRawBytes) {
    return Result.err(
      new SoftLawItemError({
        message: "Page raw byte limit exceeded",
        tag: "invalid_document",
      }),
    );
  }
  return Result.ok({
    entry,
    input,
    identityKey,
    contentHash: softLawContentHash(input),
    count,
    rawByteLength,
  });
};
const rejectedAttempt = (
  entry: SoftLawEntry,
  error: unknown,
  count: number,
): SoftLawAttempt => {
  if (SoftLawItemError.is(error)) {
    return { entry, status: "rejected", tag: error.tag, count };
  }
  if (SoftLawIngestionError.is(error)) {
    return { entry, status: "rejected", tag: "invalid_document", count };
  }
  return count >= ITEM_ATTEMPT_LIMIT
    ? { entry, status: "rejected", tag: "retry_exhausted", count }
    : { entry, status: "retryable", tag: null, count };
};
const fetchSoftLawPage = async ({
  entries,
  store,
  adapter,
  runId,
  signal,
  fetch,
}: PrepareSoftLawPageOptions) => {
  const prior = new Map(
    (await store.loadAttempts({ runId, entries })).map((attempt) => [
      attempt.url,
      attempt,
    ]),
  );
  const attempts: SoftLawAttempt[] = [];
  const fetched: FetchedSoftLawItem[] = [];
  const pendingEntries = [...prior.values()]
    .filter(
      (attempt) =>
        attempt.status === "retryable" &&
        !entries.some((entry) => entry.url === attempt.url),
    )
    .map((attempt) => attempt.entry);
  let retainedRawBytes = 0;
  for (const entry of [...entries, ...pendingEntries]) {
    signal.throwIfAborted();
    const previous = prior.get(entry.url);
    if (previous && previous.status !== "retryable") {
      continue;
    }
    const count = (previous?.count ?? 0) + 1;
    // db-await-in-loop: Renew the lease before each potentially slow document so an expired writer stops before fetching.
    const renewed = await store.renew();
    if (renewed.status === "error") {
      return renewed;
    }
    const maxRawBytes = PAGE_RAW_BYTE_LIMIT - retainedRawBytes;
    const attempted = await Result.tryPromise(
      async () =>
        await fetchSoftLawItem({
          entry,
          adapter,
          signal,
          fetch,
          count,
          maxRawBytes,
        }),
    );
    const result =
      attempted.status === "error"
        ? Result.err(attempted.error.cause)
        : attempted.value;
    const available = assertPublisherAvailable(fetch);
    if (available.status === "error") {
      return available;
    }
    signal.throwIfAborted();
    if (result.status === "error") {
      attempts.push(rejectedAttempt(entry, result.error, count));
      continue;
    }
    retainedRawBytes += result.value.rawByteLength;
    fetched.push(result.value);
  }
  return Result.ok({ attempts, fetched });
};
const prepareSoftLawPage = async (options: PrepareSoftLawPageOptions) => {
  const { store, sourceId, writeRaw, runId } = options;
  const page = await fetchSoftLawPage(options);
  if (page.status === "error") {
    return page;
  }
  const { attempts, fetched } = page.value;
  const known = fetched.length
    ? await store.loadMatches({
        entries: fetched.map((item) => item.entry),
        identityKeys: fetched.map((item) => item.identityKey),
      })
    : [];
  const observations: SoftLawObservation[] = [];
  const collisions = fetched.length
    ? await store.loadCollisions({
        entries: fetched.map(({ entry, identityKey }) => ({
          url: entry.url,
          identityKey,
        })),
      })
    : [];
  const identities = new Map<string, SoftLawObservation>();
  for (const item of fetched) {
    const { entry, input, identityKey, contentHash, count } = item;
    const matches = known.filter(
      (row) => row.document.identityKey === identityKey,
    );
    const locator = known.find((row) => row.locator?.url === entry.url);
    if (locator && locator.document.identityKey !== identityKey) {
      attempts.push({
        entry,
        count,
        status: "rejected",
        tag: "ambiguous_locator",
      });
      continue;
    }
    const accepted = identities.get(identityKey);
    const collisionInPage =
      accepted &&
      accepted.entry.url !== entry.url &&
      accepted.contentHash !== contentHash;
    const unnumbered =
      input.metadata.statedReference.state === "not_stated" &&
      input.metadata.issuedOn.state === "not_stated";
    const collisionStored = matches.some(
      (row) =>
        row.document.listingState === "listed" &&
        row.locator &&
        (unnumbered ||
          row.locator.lastSeenRun === runId ||
          collisions.some(
            (receipt) =>
              receipt.url === entry.url && receipt.identityKey === identityKey,
          )) &&
        row.locator.url !== entry.url &&
        row.version?.contentHash !== contentHash,
    );
    if (collisionInPage || collisionStored) {
      attempts.push({
        entry,
        count,
        status: "rejected",
        tag: "identity_collision",
        identityKey,
      });
      continue;
    }
    const existing = matches.at(0);
    const documentId =
      existing?.document.id ??
      accepted?.documentId ??
      createSafeId<"softLawDocument">();
    const written = await Result.tryPromise(async () => {
      const rawObjects: SoftLawObservation["rawObjects"] = [];
      for (const part of input.raw) {
        const key = await writeRaw({
          owner: { family: RAW_SOURCE_FAMILY.SOFT_LAW, sourceId },
          data: part.bytes,
          contentType: part.contentType,
          storedKey: null,
          storedContentType: null,
        });
        rawObjects.push({
          role: part.role,
          key,
          contentType: part.contentType,
        });
      }
      return { entry, input, documentId, identityKey, contentHash, rawObjects };
    });
    if (written.status === "error") {
      attempts.push(rejectedAttempt(entry, written.error.cause, count));
      continue;
    }
    observations.push(written.value);
    identities.set(identityKey, written.value);
    attempts.push({
      entry,
      count,
      status:
        existing?.version?.contentHash === contentHash
          ? "unchanged"
          : "applied",
      tag: null,
    });
  }
  return Result.ok({ observations, attempts });
};

/** Only the ingestion database capability may mutate this global corpus. */
export const runSoftLawIngestion = async ({
  sourceId,
  adapter,
  scopedDb,
  signal,
  writeRaw = writeRawSourcePayload,
  accessDependencies,
}: RunSoftLawIngestionOptions): Promise<SoftLawRunResult> => {
  const store = createSoftLawIngestionStore({ sourceId, adapter, scopedDb });
  const claimed = await store.claim();
  if (claimed.status === "error") {
    return { status: "failed", error: claimed.error };
  }
  const source = claimed.value;
  switch (source.type) {
    case "busy":
      return { status: "busy" };
    case "blocked":
      return { status: "blocked", reason: source.reason };
    case "claimed":
      break;
    default:
      source satisfies never;
      return panic("Unknown source claim state");
  }
  const runId = source.row.runId ?? panic("Claimed source has no run id");
  const fetch = createSoftLawFetch({
    policy: adapter.access,
    signal,
    ...accessDependencies,
    beforeRequest: store.renew,
  });
  let cursor = source.row.syncCursor;
  const attemptedOutcome = await Result.tryPromise(
    async (): Promise<Result<SoftLawRunResult, unknown>> => {
      const total = await adapter.getTotalCount({ signal, fetch });
      const available = assertPublisherAvailable(fetch);
      if (available.status === "error") {
        return available;
      }
      if (total.type === "probe-failed") {
        return Result.err(
          new SoftLawListingIncompleteError({
            message: "Source listing size probe failed",
          }),
        );
      }
      const expectedTotal = total.type === "count" ? total.total : null;
      if (
        expectedTotal !== null &&
        (!Number.isSafeInteger(expectedTotal) || expectedTotal < 0)
      ) {
        return Result.err(
          new SoftLawListingIncompleteError({
            message: "Invalid declared listing size",
          }),
        );
      }
      for (let pageNumber = 0; pageNumber < PAGE_BUDGET; pageNumber++) {
        signal.throwIfAborted();
        // db-await-in-loop: Cursor pages depend on the previous checkpoint; renew before each discovery request.
        const renewed = await store.renew();
        if (renewed.status === "error") {
          return renewed;
        }
        const page = await adapter.discover({ cursor, signal, fetch });
        const pageAvailable = assertPublisherAvailable(fetch);
        if (pageAvailable.status === "error") {
          return pageAvailable;
        }
        if (
          page.entries.length > SOFT_LAW_BATCH_LIMIT ||
          new Set(page.entries.map((entry) => entry.url)).size !==
            page.entries.length ||
          (page.nextCursor !== null && page.nextCursor === cursor)
        ) {
          return Result.err(
            new SoftLawIngestionError({
              message: "Invalid discovery batch or cursor",
            }),
          );
        }
        const prepared = await prepareSoftLawPage({
          entries: page.entries,
          store,
          adapter,
          sourceId,
          runId,
          signal,
          fetch,
          writeRaw,
        });
        if (prepared.status === "error") {
          return prepared;
        }
        const retryable = prepared.value.attempts.some(
          (attempt) => attempt.status === "retryable",
        );
        // db-await-in-loop: Commit this page and checkpoint atomically before walking the next cursor.
        const persisted = await store.persistPage({
          ...prepared.value,
          expectedCursor: cursor,
          nextCursor: retryable ? cursor : page.nextCursor,
          runId,
          expectedTotal,
          pendingRetries: retryable,
        });
        if (persisted.status === "error") {
          return persisted;
        }
        if (persisted.value.status === "listing_incomplete") {
          return Result.ok(persisted.value);
        }
        if (retryable) {
          return Result.ok({ status: "paused" });
        }
        cursor = page.nextCursor;
        if (cursor === null) {
          return Result.ok({ status: "complete" });
        }
      }
      return Result.ok({ status: "paused" });
    },
  );
  const outcome =
    attemptedOutcome.status === "error"
      ? Result.err(attemptedOutcome.error.cause)
      : attemptedOutcome.value;
  const blocked = fetch.getBlockReason();
  if (blocked) {
    await store.settle({ status: "blocked", reason: blocked });
    return { status: "blocked", reason: blocked };
  }
  if (fetch.getWindowState() === "deferred_window") {
    await store.settle({ status: "paused", reason: "deferred_window" });
    return { status: "paused", reason: "deferred_window" };
  }
  if (outcome.status === "ok") {
    if (outcome.value.status === "paused") {
      await store.settle({ status: "paused" });
    }
    return outcome.value;
  }
  await store.settle({
    status: "failed",
    reason: SoftLawListingIncompleteError.is(outcome.error)
      ? "listing_incomplete"
      : "ingestion_failed",
  });
  return { status: "failed", error: outcome.error };
};
