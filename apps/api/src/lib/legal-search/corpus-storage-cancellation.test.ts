import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { envBase } from "@/api/env-base";
import {
  corpusContentHash,
  corpusKeys,
  deleteCorpusDocument,
  writeCorpusDocument,
} from "@/api/lib/legal-search/corpus-storage";
import { EMPTY_AST } from "@/api/lib/legal-search/document-types";
import { startFakeS3 } from "@/api/tests/helpers/fake-s3";
import type { FakeS3, FakeS3Method } from "@/api/tests/helpers/fake-s3";

const corpusBucket = envBase.LEGAL_CORPUS_S3_BUCKET ?? envBase.S3_BUCKET;

/**
 * How long the store holds a served response. Long enough that three
 * requests are provably in flight at once, short enough that a test which
 * waits out a straggler stays fast.
 */
const HOLD_MS = 150;

const errorName = (error: unknown): string =>
  error instanceof Error ? error.name : String(error);

const waitForRequests = async (
  fake: FakeS3,
  method: FakeS3Method,
  expected: number,
): Promise<void> => {
  await new Promise<void>((resolve) => {
    const check = () => {
      if (
        fake.requests.filter((request) => request.method === method).length >=
        expected
      ) {
        resolve();
        return;
      }
      setTimeout(check, 1);
    };
    check();
  });
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

// The store holds every served response, so the group's three requests are
// genuinely in flight when the test cancels or rejects one of them.
describe("corpus object cancellation", () => {
  let fake: FakeS3;

  beforeEach(() => {
    fake = startFakeS3({ delayMs: HOLD_MS });
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
    const controller = new AbortController();
    const pending = writeRejection(controller.signal);

    await waitForRequests(fake, "PUT", 3);
    controller.abort();

    const rejection = await pending;

    expect(errorName(rejection)).toBe("AbortError");
    // Cancellation reached the requests themselves: all three were in flight
    // and none of them landed an object.
    expect(keysUnder(fake)).toEqual([]);
    // Nor does one land once the hold on the cancelled requests expires.
    await Bun.sleep(HOLD_MS * 2);
    expect(keysUnder(fake)).toEqual([]);
  });

  test("reports a rejected corpus PUT rather than the siblings it cancelled", async () => {
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
    await Bun.sleep(HOLD_MS * 2);
    expect(keysUnder(fake)).toEqual([]);
  });

  test("passes caller cancellation to every in-flight corpus DELETE", async () => {
    for (const key of Object.values(deletedKeys)) {
      fake.put(corpusBucket, key, "payload");
    }
    const controller = new AbortController();
    const pending = deleteCorpusDocument(deletedKeys, {
      signal: controller.signal,
    }).then(
      () => null,
      (error: unknown) => error,
    );

    await waitForRequests(fake, "DELETE", 3);
    controller.abort();

    const rejection = await pending;

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
    fake.failNext({
      method: "DELETE",
      code: "AccessDenied",
      status: 403,
      key: deletedKeys.textKey,
    });

    const rejection = await deleteCorpusDocument(deletedKeys).then(
      () => null,
      (error: unknown) => error,
    );

    expect(errorName(rejection)).toBe("AccessDenied");
    // The erasure failed as a whole, so no sibling delete may apply late and
    // leave the caller with a half-erased document it was never told about.
    await Bun.sleep(HOLD_MS * 2);
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
    const outcome = await writeCorpusDocument({
      documentId: redundancyDocumentId,
      jurisdiction,
      // The metadata-first shape: no text, no sections, the empty-AST
      // placeholder an adapter without a document emits.
      text: null,
      sections: null,
      ast: EMPTY_AST,
      stored: null,
    });

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

    const outcome = await writeCorpusDocument({
      documentId: redundancyDocumentId,
      jurisdiction,
      ...redundancyPayload,
      stored,
    });

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

    const outcome = await writeCorpusDocument({
      documentId: redundancyDocumentId,
      jurisdiction,
      ...changed,
      stored,
    });

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
