/**
 * The envelope's binary parts: what a row states about a publisher's file,
 * and whether the bytes are where it says they are.
 *
 * An envelope is text, so a decision whose publisher serves a file has to
 * name it rather than hold it. The reference is written in the address form
 * the corpus key columns already use, so the standalone object written today
 * and a packed address later are one shape and one reader.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { envBase } from "@/api/env-base";
import { parseCorpusLocation } from "@/api/lib/legal-search/corpus-location";
import {
  decodeSourceRawEnvelope,
  decodeSourceRawEnvelopeObjects,
  encodeSourceRawEnvelope,
  withSourceRawObjects,
} from "@/api/lib/legal-search/ingestion-types";
import {
  RAW_SOURCE_FAMILY,
  rawSourcePayloadKey,
  sourceBinaryRef,
  writeRawSourcePayload,
  writeSourceBinary,
} from "@/api/lib/legal-search/raw-source-storage";
import { startFakeS3 } from "@/api/tests/helpers/fake-s3";
import type { FakeS3 } from "@/api/tests/helpers/fake-s3";

const SOURCE_ID = "01920000-0000-7000-8000-000000000000";

const A_REFERENCE = {
  location: "case-law/raw/a-source/abc",
  sha256: "a".repeat(64),
  contentType: "application/pdf",
  byteLength: 19,
} as const;

describe("an envelope that names a binary part", () => {
  test("keeps the text parts a reader of the earlier shape already reads", () => {
    const raw = encodeSourceRawEnvelope(
      { listing: "{}" },
      { "document-file": A_REFERENCE },
    );

    expect(decodeSourceRawEnvelope(raw)).toEqual({ listing: "{}" });
    expect(decodeSourceRawEnvelopeObjects(raw)).toEqual({
      "document-file": A_REFERENCE,
    });
  });

  test("an envelope with no binary part is byte-identical to one written before they existed", () => {
    expect(encodeSourceRawEnvelope({ listing: "{}" }, {})).toBe(
      encodeSourceRawEnvelope({ listing: "{}" }),
    );
  });

  test("a payload that names no objects reads as naming none, not as broken", () => {
    // Every absence there is: a row from before binaries, a payload that is
    // not an envelope at all, and one whose map does not read as references.
    expect(
      decodeSourceRawEnvelopeObjects(
        encodeSourceRawEnvelope({ listing: "{}" }),
      ),
    ).toEqual({});
    expect(decodeSourceRawEnvelopeObjects("<html></html>")).toEqual({});
    expect(
      decodeSourceRawEnvelopeObjects(
        JSON.stringify({ version: 1, parts: {}, objects: { a: "not a ref" } }),
      ),
    ).toEqual({});
  });

  test("closing an envelope over its objects leaves a non-envelope payload alone", () => {
    const objects = { "document-file": A_REFERENCE };

    expect(withSourceRawObjects("<html></html>", objects)).toBe(
      "<html></html>",
    );
    expect(
      decodeSourceRawEnvelopeObjects(
        withSourceRawObjects(
          encodeSourceRawEnvelope({ listing: "{}" }),
          objects,
        ),
      ),
    ).toEqual(objects);
  });
});

const DECISION_ID = "01920000-0000-7000-8000-00000000000a";

const fileInput = (text: string) =>
  ({
    family: RAW_SOURCE_FAMILY.CASE_LAW,
    sourceId: SOURCE_ID,
    documentId: DECISION_ID,
    bytes: new TextEncoder().encode(text),
    contentType: "application/pdf",
  }) as const;

describe("storing a publisher file beside the decision's raw payload", () => {
  let fake: FakeS3;

  beforeEach(() => {
    fake = startFakeS3();
  });

  afterEach(() => {
    fake.stop();
  });

  test("the bytes land at the address the envelope names them by", async () => {
    const input = fileInput("%PDF-1.4 a decision");

    const ref = await writeSourceBinary(input);

    // The address is written in the corpus location form, so a later change
    // that packs these files replaces the address and nothing else.
    const location = parseCorpusLocation(ref.location);
    expect(location.type).toBe("object");
    const stored = fake.objects.get(
      `${envBase.S3_BUCKET}/${location.type === "object" ? location.key : ""}`,
    );
    expect([...(stored?.bytes ?? [])]).toEqual([...input.bytes]);
    expect(stored?.contentType).toBe("application/pdf");
    expect(ref.byteLength).toBe(input.bytes.byteLength);
  });

  test("the reference a caller derives is the one the write produces", async () => {
    const input = fileInput("%PDF-1.4 another decision");

    // What a fixture, a replay or a dry run has to state about a row before
    // the write happens, held to the write by construction rather than by a
    // second copy of the key format.
    expect(await writeSourceBinary(input)).toEqual(sourceBinaryRef(input));
  });

  test("the same file observed again is stored once, as one version", async () => {
    const input = fileInput("%PDF-1.4 one document");

    const first = await writeSourceBinary(input);
    const second = await writeSourceBinary(input);

    expect(second).toEqual(first);
    expect([...fake.versions.values()]).toEqual([1]);
    // The repeat asked the store to create the object only if absent.
    expect(fake.requests.at(-1)).toMatchObject({
      method: "PUT",
      ifNoneMatch: "*",
    });
  });

  test("concurrent writers of the same file converge on one version", async () => {
    fake.stop();
    // Both requests are in flight together before either applies.
    fake = startFakeS3({ delayMs: 50 });
    const input = fileInput("%PDF-1.4 raced");

    const [a, b] = await Promise.all([
      writeSourceBinary(input),
      writeSourceBinary(input),
    ]);

    expect(a).toEqual(b);
    expect(fake.requests.filter(({ method }) => method === "PUT")).toHaveLength(
      2,
    );
    expect([...fake.versions.values()]).toEqual([1]);
  });

  test("a conflicting concurrent write is retried until it sees the winner", async () => {
    const input = fileInput("%PDF-1.4 conflicted");
    await writeSourceBinary(input);
    // What S3 answers while another conditional write to the key is in
    // flight; the retry then finds the object and is answered 412.
    fake.failNext({
      method: "PUT",
      code: "ConditionalRequestConflict",
      status: 409,
    });

    await writeSourceBinary(input);

    expect(fake.requests.filter(({ method }) => method === "PUT")).toHaveLength(
      3,
    );
    expect([...fake.versions.values()]).toEqual([1]);
  });

  test("the same file served for two decisions is held once per decision", () => {
    const input = fileInput("%PDF-1.4 joined proceedings");

    expect(
      sourceBinaryRef({ ...input, documentId: "another-decision" }).location,
    ).not.toBe(sourceBinaryRef(input).location);
  });
});

describe("storing a publisher's raw payload", () => {
  let fake: FakeS3;

  beforeEach(() => {
    fake = startFakeS3();
  });

  afterEach(() => {
    fake.stop();
  });

  const payload = {
    family: RAW_SOURCE_FAMILY.CASE_LAW,
    sourceId: SOURCE_ID,
    data: "<html>a decision</html>",
    contentType: "text/html",
  } as const;

  test("a payload the row already records is not written", async () => {
    const key = rawSourcePayloadKey(payload);

    await writeRawSourcePayload({
      ...payload,
      storedKey: key,
      storedContentType: "text/html",
    });

    expect(fake.requests).toEqual([]);
  });

  test("a payload stored before but not recorded adds no version", async () => {
    // A row that moved to another payload and back, or a retry after the
    // row write failed: the key holds these bytes already.
    await writeRawSourcePayload({
      ...payload,
      storedKey: null,
      storedContentType: null,
    });
    await writeRawSourcePayload({
      ...payload,
      storedKey: "case-law/raw/another",
      storedContentType: "text/html",
    });

    expect([...fake.versions.values()]).toEqual([1]);
  });

  test("a changed content type on the recorded payload is rewritten", async () => {
    const key = rawSourcePayloadKey(payload);
    fake.put(envBase.S3_BUCKET, key, payload.data, "text/plain");

    await writeRawSourcePayload({
      ...payload,
      storedKey: key,
      storedContentType: "text/plain",
    });

    expect(
      fake.objects.get(`${envBase.S3_BUCKET}/${key}`)?.contentType,
    ).toMatch(/^text\/html\b/u);
  });
});
