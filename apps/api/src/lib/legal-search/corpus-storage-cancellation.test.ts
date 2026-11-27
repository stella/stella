import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { EMPTY_AST } from "@stll/legal-ast/document-types";
import { settledWithin } from "@stll/test-kit";

import { envBase } from "@/api/env-base";
import { createSafeId } from "@/api/lib/branded-types";
import {
  corpusContentHash,
  corpusKeys,
  deleteCorpusDocument,
  writeCorpusDocument,
} from "@/api/lib/legal-search/corpus-storage";
import type { CorpusTombstoneEntry } from "@/api/lib/legal-search/corpus-tombstones";
import { startFakeS3 } from "@/api/tests/helpers/fake-s3";
import type {
  FakeS3,
  FakeS3Hold,
  FakeS3Method,
} from "@/api/tests/helpers/fake-s3";

const corpusBucket = envBase.LEGAL_CORPUS_S3_BUCKET ?? envBase.S3_BUCKET;

const errorName = (error: unknown): string =>
  error instanceof Error ? error.name : String(error);

const holdKeys = (
  fake: FakeS3,
  method: FakeS3Method,
  keys: readonly string[],
): FakeS3Hold[] =>
  keys.map((key) => fake.holdNext({ method, keyIncludes: key }));

const releaseAbortedHolds = async (
  holds: readonly FakeS3Hold[],
): Promise<void> => {
  await settledWithin(
    Promise.all(holds.map(async (hold) => await hold.aborted)),
    {
      description: "cancelled S3 requests to abort at server",
      timeoutMs: 5000,
    },
  );
  for (const hold of holds) {
    hold.release();
  }
  await Promise.all(holds.map(async (hold) => await hold.completed));
};

const keysUnder = (fake: FakeS3): string[] =>
  [...fake.objects.keys()]
    .map((id) => id.slice(corpusBucket.length + 1))
    .toSorted();

const documentId = "decision-1";
const jurisdiction = "SVK";
const payload = { text: "decision text", sections: null, ast: null };
const writtenKeys = corpusKeys({
  documentId,
  jurisdiction,
  contentHash: corpusContentHash(payload),
});

const writeRejection = async (signal: AbortSignal): Promise<unknown> =>
  await writeCorpusDocument(
    { documentId, jurisdiction, ...payload, stored: null },
    { signal },
  ).then(
    () => null,
    (error: unknown) => error,
  );

const deletedKeys = {
  textKey: "corpus/text",
  sectionsKey: "corpus/sections",
  astKey: "corpus/ast",
};

// Every key above is a standalone object, so the erasure has nothing to
// tombstone; the writer is here because a caller must always name where a
// denial would be written.
const erasure = {
  decisionId: createSafeId<"caseLawDecision">(),
  tombstone: async (
    entries: readonly CorpusTombstoneEntry[],
  ): Promise<void> => {
    expect(entries).toEqual([]);
    await Promise.resolve();
  },
};

// The store holds every served response, so the group's three requests are
// genuinely in flight when the test cancels or rejects one of them.
describe("corpus object cancellation", () => {
  let fake: FakeS3;

  beforeEach(() => {
    fake = startFakeS3();
  });

  afterEach(() => {
    fake.stop();
  });

  test("does not start a corpus PUT for an already-cancelled owner", async () => {
    const controller = new AbortController();
    controller.abort();

    const rejection = await writeRejection(controller.signal);

    expect(errorName(rejection)).toBe("AbortError");
    expect(fake.requests).toHaveLength(0);
  });

  test("passes caller cancellation to every in-flight corpus PUT", async () => {
    const holds = holdKeys(fake, "PUT", [
      writtenKeys.textKey,
      writtenKeys.sectionsKey,
      writtenKeys.astKey,
    ]);
    const controller = new AbortController();
    const pending = writeRejection(controller.signal);

    await Promise.all(holds.map(async (hold) => await hold.reached));
    controller.abort();

    const rejection = await pending;

    expect(errorName(rejection)).toBe("AbortError");
    // Cancellation reached the requests themselves: all three were in flight
    // and none of them landed an object.
    expect(keysUnder(fake)).toEqual([]);
    // Nor does one land once the hold on the cancelled requests is released.
    await releaseAbortedHolds(holds);
    expect(keysUnder(fake)).toEqual([]);
  });

  test("reports a rejected corpus PUT rather than the siblings it cancelled", async () => {
    const holds = holdKeys(fake, "PUT", [
      writtenKeys.sectionsKey,
      writtenKeys.astKey,
    ]);
    fake.failNext({
      method: "PUT",
      code: "AccessDenied",
      status: 403,
      key: writtenKeys.textKey,
    });

    const rejection = await writeRejection(new AbortController().signal);

    // The denial is the diagnosable failure; an AbortError would name only
    // the cleanup the write performed on itself.
    expect(errorName(rejection)).toBe("AccessDenied");
    // A sibling PUT that outlived the failure would recreate an object under
    // keys the caller has already given up on, so nothing may land after the
    // write returns either.
    expect(keysUnder(fake)).toEqual([]);
    await releaseAbortedHolds(holds);
    expect(keysUnder(fake)).toEqual([]);
  });

  test("passes caller cancellation to every in-flight corpus DELETE", async () => {
    for (const key of Object.values(deletedKeys)) {
      fake.put(corpusBucket, key, "payload");
    }
    const holds = holdKeys(fake, "DELETE", Object.values(deletedKeys));
    const controller = new AbortController();
    const pending = deleteCorpusDocument(deletedKeys, {
      ...erasure,
      signal: controller.signal,
    }).then(
      () => null,
      (error: unknown) => error,
    );

    await Promise.all(holds.map(async (hold) => await hold.reached));
    controller.abort();

    const rejection = await pending;
    await releaseAbortedHolds(holds);

    expect(errorName(rejection)).toBe("AbortError");
    // A cancelled erasure removes nothing: the caller retries the whole set.
    expect(keysUnder(fake)).toEqual([
      deletedKeys.astKey,
      deletedKeys.sectionsKey,
      deletedKeys.textKey,
    ]);
  });

  test("reports a rejected corpus DELETE rather than the siblings it cancelled", async () => {
    for (const key of Object.values(deletedKeys)) {
      fake.put(corpusBucket, key, "payload");
    }
    const holds = holdKeys(fake, "DELETE", [
      deletedKeys.sectionsKey,
      deletedKeys.astKey,
    ]);
    fake.failNext({
      method: "DELETE",
      code: "AccessDenied",
      status: 403,
      key: deletedKeys.textKey,
    });

    const rejection = await deleteCorpusDocument(deletedKeys, erasure).then(
      () => null,
      (error: unknown) => error,
    );

    expect(errorName(rejection)).toBe("AccessDenied");
    // The erasure failed as a whole, so no sibling delete may apply late and
    // leave the caller with a half-erased document it was never told about.
    await releaseAbortedHolds(holds);
    expect(keysUnder(fake)).toEqual([
      deletedKeys.astKey,
      deletedKeys.sectionsKey,
      deletedKeys.textKey,
    ]);
  });
});

describe("corpus write redundancy refusal", () => {
  let fake: FakeS3;
  const redundancyDocumentId = "7f9b1c34-52ad-4c8e-b1f0-6a2d9e4c8b21";
  const redundancyPayload = {
    text: "Rozsudok v mene Slovenskej republiky. Súd rozhodol o veci samej.",
    sections: null,
    ast: null,
  };

  beforeEach(() => {
    fake = startFakeS3();
  });

  afterEach(() => {
    fake.stop();
  });

  test("an empty payload issues no corpus PUTs", async () => {
    const outcome = (
      await writeCorpusDocument({
        documentId: redundancyDocumentId,
        jurisdiction,
        // The metadata-first shape: no text, no sections, the empty-AST
        // placeholder an adapter without a document emits.
        text: null,
        sections: null,
        ast: EMPTY_AST,
        stored: null,
      })
    ).unwrap();

    expect(outcome).toEqual({
      type: "skipped-empty",
      written: null,
      contentHash: corpusContentHash({
        text: null,
        sections: null,
        ast: EMPTY_AST,
      }),
    });
    expect(fake.requests).toHaveLength(0);
  });

  test("a payload the row already records issues no corpus PUTs", async () => {
    const contentHash = corpusContentHash(redundancyPayload);
    const stored = {
      ...corpusKeys({
        documentId: redundancyDocumentId,
        jurisdiction,
        contentHash,
      }),
      contentHash,
    };

    const outcome = (
      await writeCorpusDocument({
        documentId: redundancyDocumentId,
        jurisdiction,
        ...redundancyPayload,
        stored,
      })
    ).unwrap();

    expect(outcome).toEqual({ type: "skipped-unchanged", written: stored });
    expect(fake.requests).toHaveLength(0);
  });

  test("a changed payload still issues all three PUTs", async () => {
    const previousHash = corpusContentHash(redundancyPayload);
    const stored = {
      ...corpusKeys({
        documentId: redundancyDocumentId,
        jurisdiction,
        contentHash: previousHash,
      }),
      contentHash: previousHash,
    };
    const changed = {
      ...redundancyPayload,
      text: `${redundancyPayload.text} Opravené znenie.`,
    };
    expect(corpusContentHash(changed)).not.toBe(previousHash);

    const outcome = (
      await writeCorpusDocument({
        documentId: redundancyDocumentId,
        jurisdiction,
        ...changed,
        stored,
      })
    ).unwrap();

    const changedKeys = corpusKeys({
      documentId: redundancyDocumentId,
      jurisdiction,
      contentHash: corpusContentHash(changed),
    });
    expect(outcome).toMatchObject({
      type: "written",
      written: { contentHash: corpusContentHash(changed) },
    });
    // The three payload objects landed under the new content hash, each
    // stored as a zstd frame.
    expect(keysUnder(fake)).toEqual(
      [
        changedKeys.astKey,
        changedKeys.sectionsKey,
        changedKeys.textKey,
      ].toSorted(),
    );
    expect(
      fake.objects.get(`${corpusBucket}/${changedKeys.textKey}`)?.contentType,
    ).toBe("application/zstd");
  });
});
