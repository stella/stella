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

import { createSoftLawFetch, SoftLawBlockedError } from "./publisher-access";

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
  | { status: "failed"; error: unknown };

const assertPublisherAvailable = (fetch: SoftLawFetch) => {
  const reason = fetch.getBlockReason();
  if (reason) {
    throw new SoftLawBlockedError({
      message: "Publisher blocked this source",
      reason,
    });
  }
  if (fetch.getWindowState() === "deferred_window") {
    throw new SoftLawIngestionError({ message: "Publisher window is closed" });
  }
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
  const input = await adapter.fetchDocument(entry, { signal, fetch });
  const identityKey = softLawIdentityKey(adapter.authority, input.metadata);
  if (
    !input.raw.length ||
    input.raw.length > DOCUMENT_RAW_PART_LIMIT ||
    new Set(input.raw.map((part) => part.role)).size !== input.raw.length
  ) {
    throw new SoftLawItemError({
      message: "Document raw parts are missing or ambiguous",
      tag: "invalid_document",
    });
  }
  const rawByteLength = input.raw.reduce(
    (total, part) => total + part.bytes.byteLength,
    0,
  );
  if (rawByteLength > maxRawBytes) {
    throw new SoftLawItemError({
      message: "Page raw byte limit exceeded",
      tag: "invalid_document",
    });
  }
  return {
    entry,
    input,
    identityKey,
    contentHash: softLawContentHash(input),
    count,
    rawByteLength,
  };
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
    const maxRawBytes = PAGE_RAW_BYTE_LIMIT - retainedRawBytes;
    const result = await Result.tryPromise(() =>
      fetchSoftLawItem({ entry, adapter, signal, fetch, count, maxRawBytes }),
    );
    assertPublisherAvailable(fetch);
    signal.throwIfAborted();
    if (Result.isError(result)) {
      attempts.push(rejectedAttempt(entry, result.error.cause, count));
      continue;
    }
    retainedRawBytes += result.value.rawByteLength;
    fetched.push(result.value);
  }
  return { attempts, fetched };
};
const prepareSoftLawPage = async (options: PrepareSoftLawPageOptions) => {
  const { store, sourceId, writeRaw } = options;
  const { attempts, fetched } = await fetchSoftLawPage(options);
  const known = fetched.length
    ? await store.loadMatches({
        entries: fetched.map((item) => item.entry),
        identityKeys: fetched.map((item) => item.identityKey),
      })
    : [];
  const observations: SoftLawObservation[] = [];
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
    const collisionStored =
      unnumbered &&
      matches.some(
        (row) =>
          row.document.listingState === "listed" &&
          row.locator &&
          row.locator.url !== entry.url &&
          row.version?.contentHash !== contentHash,
      );
    if (collisionInPage || collisionStored) {
      attempts.push({
        entry,
        count,
        status: "rejected",
        tag: "identity_collision",
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
    if (Result.isError(written)) {
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
  return { observations, attempts };
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
  const source = await store.claim();
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
  });
  let cursor = source.row.syncCursor;
  const outcome = await Result.tryPromise(
    async (): Promise<SoftLawRunResult> => {
      const total = await adapter.getTotalCount({ signal, fetch });
      assertPublisherAvailable(fetch);
      if (total.type === "probe-failed") {
        throw new SoftLawListingIncompleteError({
          message: "Source listing size probe failed",
        });
      }
      const expectedTotal = total.type === "count" ? total.total : null;
      if (
        expectedTotal !== null &&
        (!Number.isSafeInteger(expectedTotal) || expectedTotal < 0)
      ) {
        throw new SoftLawListingIncompleteError({
          message: "Invalid declared listing size",
        });
      }
      for (let pageNumber = 0; pageNumber < PAGE_BUDGET; pageNumber++) {
        signal.throwIfAborted();
        await store.renew();
        const page = await adapter.discover({ cursor, signal, fetch });
        assertPublisherAvailable(fetch);
        if (
          page.entries.length > SOFT_LAW_BATCH_LIMIT ||
          new Set(page.entries.map((entry) => entry.url)).size !==
            page.entries.length ||
          (page.nextCursor !== null && page.nextCursor === cursor)
        ) {
          throw new SoftLawIngestionError({
            message: "Invalid discovery batch or cursor",
          });
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
        const retryable = prepared.attempts.some(
          (attempt) => attempt.status === "retryable",
        );
        await store.persistPage({
          ...prepared,
          expectedCursor: cursor,
          nextCursor: retryable ? cursor : page.nextCursor,
          runId,
          expectedTotal,
          pendingRetries: retryable,
        });
        if (retryable) {
          return { status: "paused" };
        }
        cursor = page.nextCursor;
        if (cursor === null) {
          return { status: "complete" };
        }
      }
      return { status: "paused" };
    },
  );
  const blocked = fetch.getBlockReason();
  if (blocked) {
    await store.settle({ status: "blocked", reason: blocked });
    return { status: "blocked", reason: blocked };
  }
  if (fetch.getWindowState() === "deferred_window") {
    await store.settle({ status: "paused", reason: "deferred_window" });
    return { status: "paused", reason: "deferred_window" };
  }
  if (Result.isOk(outcome)) {
    if (outcome.value.status === "paused") {
      await store.settle({ status: "paused" });
    }
    return outcome.value;
  }
  await store.settle({
    status: "failed",
    reason: SoftLawListingIncompleteError.is(outcome.error.cause)
      ? "listing_incomplete"
      : "ingestion_failed",
  });
  return { status: "failed", error: outcome.error };
};
