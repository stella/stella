import { panic, Result } from "better-result";

import type { ScopedDb } from "@/api/db/safe-db";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import {
  writeRawSourcePayload,
  RAW_SOURCE_FAMILY,
} from "@/api/lib/legal-search/raw-source-storage";
import type { WriteRawSourcePayload } from "@/api/lib/legal-search/raw-source-storage";
import { createSoftLawIngestionStore } from "@/api/lib/legal-search/soft-law-ingestion-store";
import type { SoftLawObservation } from "@/api/lib/legal-search/soft-law-ingestion-store";
import { SoftLawIngestionError } from "@/api/lib/legal-search/soft-law-types";
import type {
  SoftLawMetadata,
  SoftLawSourceAdapter,
  SoftLawEntry,
} from "@/api/lib/legal-search/soft-law-types";

import type { SoftLawFetch } from "./publisher-access";
import { createSoftLawFetch, SoftLawBlockedError } from "./publisher-access";

export const SOFT_LAW_BATCH_LIMIT = 100;
const PAGE_BUDGET = 20;
const PAGE_RAW_BYTE_LIMIT = 64 * 1024 * 1024;
const DOCUMENT_RAW_PART_LIMIT = 20;
const normalizeIdentityText = (value: string) =>
  value.normalize("NFC").trim().replace(/\s+/gu, " ").toLocaleLowerCase("und");

/** URL is a locator, never an identity. Tuple encoding prevents delimiter collisions. */
export const softLawIdentityKey = (
  authority: string,
  metadata: SoftLawMetadata,
): string => {
  if (!metadata.title.trim()) {
    throw new SoftLawIngestionError({ message: "Document title is empty" });
  }
  switch (metadata.statedReference.state) {
    case "stated":
      if (!metadata.statedReference.value.trim()) {
        throw new SoftLawIngestionError({
          message: "Document reference is empty",
        });
      }
      return JSON.stringify([
        authority,
        "reference",
        normalizeIdentityText(metadata.statedReference.value),
      ]);
    case "not_stated":
      return JSON.stringify([
        authority,
        "title",
        normalizeIdentityText(metadata.title),
        metadata.issuedOn.state === "stated" ? metadata.issuedOn.value : null,
      ]);
    default:
      metadata.statedReference satisfies never;
      return panic("Unknown stated reference state");
  }
};

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
  | { status: "blocked"; reason: string }
  | { status: "failed"; error: unknown };

type PrepareSoftLawPageOptions = {
  entries: readonly SoftLawEntry[];
  store: ReturnType<typeof createSoftLawIngestionStore>;
  adapter: SoftLawSourceAdapter;
  sourceId: SafeId<"softLawSource">;
  signal: AbortSignal;
  fetch: SoftLawFetch;
  writeRaw: WriteRawSourcePayload;
};
const prepareSoftLawPage = async ({
  entries,
  store,
  adapter,
  sourceId,
  signal,
  fetch,
  writeRaw,
}: PrepareSoftLawPageOptions) => {
  const observations: SoftLawObservation[] = [];
  let pageRawBytes = 0;
  const pageIdentities = new Map<string, SafeId<"softLawDocument">>();
  const pageLocators = new Map<string, string>();
  for (const entry of entries) {
    signal.throwIfAborted();
    await store.renew();
    const input = await adapter.fetchDocument(entry, { signal, fetch });
    const identityKey = softLawIdentityKey(adapter.authority, input.metadata);
    // Match a known locator first: a publisher may rename an unnumbered document.
    const known = await store.findDocument({ identityKey, url: entry.url });
    const ids = new Set(known.map((row) => row.id));
    if (ids.size > 1) {
      throw new SoftLawIngestionError({
        message: "Document identity conflicts with its locator",
      });
    }
    const matched = known.at(0);
    if (
      matched?.statedReferenceState === "stated" &&
      input.metadata.statedReference.state === "stated" &&
      normalizeIdentityText(
        matched.statedReference ?? panic("Stated reference missing"),
      ) !== normalizeIdentityText(input.metadata.statedReference.value)
    ) {
      throw new SoftLawIngestionError({
        message: "Locator conflicts with the stated document reference",
      });
    }
    const existingId = matched?.id;
    const documentId =
      existingId ??
      pageIdentities.get(identityKey) ??
      createSafeId<"softLawDocument">();
    if (
      pageLocators.has(entry.url) &&
      pageLocators.get(entry.url) !== identityKey
    ) {
      throw new SoftLawIngestionError({
        message: "Listing locator has conflicting identities",
      });
    }
    pageLocators.set(entry.url, identityKey);
    pageIdentities.set(identityKey, documentId);
    if (
      !input.raw.length ||
      input.raw.length > DOCUMENT_RAW_PART_LIMIT ||
      new Set(input.raw.map((part) => part.role)).size !== input.raw.length
    ) {
      throw new SoftLawIngestionError({
        message: "Document raw parts are missing or ambiguous",
      });
    }
    pageRawBytes += input.raw.reduce(
      (total, part) => total + part.bytes.byteLength,
      0,
    );
    if (pageRawBytes > PAGE_RAW_BYTE_LIMIT) {
      throw new SoftLawIngestionError({
        message: "Discovery batch exceeds the raw byte limit",
      });
    }
    // Source-wide content addresses survive a crash before document insertion.
    const rawObjects = [];
    for (const part of input.raw) {
      const key = await writeRaw({
        owner: { family: RAW_SOURCE_FAMILY.SOFT_LAW, sourceId },
        data: part.bytes,
        contentType: part.contentType,
        storedKey: null,
        storedContentType: null,
      });
      rawObjects.push({ role: part.role, key, contentType: part.contentType });
    }
    const rawDigests = input.raw
      .map((part) => ({
        role: part.role,
        digest: new Bun.CryptoHasher("sha256").update(part.bytes).digest("hex"),
      }))
      .toSorted((left, right) => {
        if (left.role === right.role) {
          return 0;
        }
        return left.role < right.role ? -1 : 1;
      });
    const contentHash = new Bun.CryptoHasher("sha256")
      .update(JSON.stringify(rawDigests))
      .digest("hex");
    observations.push({
      entry,
      input,
      existingId,
      documentId,
      identityKey,
      contentHash,
      rawObjects,
    });
  }
  return observations;
};

/** The supplied database capability is owner-only global corpus ingestion. */
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
  const runStartedAt =
    source.row.runStartedAt ?? panic("Claimed source has no start date");
  const fetch = createSoftLawFetch({
    policy: adapter.access,
    signal,
    beforeRequest: store.renew,
    ...accessDependencies,
  });
  let cursor = source.row.syncCursor;
  const outcome = await Result.tryPromise(
    async (): Promise<SoftLawRunResult> => {
      for (let pageNumber = 0; pageNumber < PAGE_BUDGET; pageNumber++) {
        signal.throwIfAborted();
        await store.renew();
        const page = await adapter.discover({ cursor, signal, fetch });
        if (
          page.entries.length > SOFT_LAW_BATCH_LIMIT ||
          (page.nextCursor !== null && page.nextCursor === cursor)
        ) {
          throw new SoftLawIngestionError({
            message: "Invalid discovery batch or cursor",
          });
        }
        const observations = await prepareSoftLawPage({
          entries: page.entries,
          store,
          adapter,
          sourceId,
          signal,
          fetch,
          writeRaw,
        });
        const expectedCursor = cursor;
        await store.persistPage({
          observations,
          expectedCursor,
          nextCursor: page.nextCursor,
          runId,
          runStartedAt,
        });
        cursor = page.nextCursor;
        if (cursor === null) {
          return { status: "complete" };
        }
      }
      return { status: "paused" };
    },
  );
  if (Result.isOk(outcome)) {
    if (outcome.value.status === "paused") {
      await store.settle({ status: "paused" });
    }
    return outcome.value;
  }
  const cause = outcome.error.cause;
  const blocked = SoftLawBlockedError.is(cause);
  await store.settle(
    blocked
      ? { status: "blocked", reason: cause.reason }
      : { status: "failed" },
  );
  return blocked
    ? { status: "blocked", reason: cause.reason }
    : { status: "failed", error: outcome.error };
};
