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
  sourceBinaryRef,
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

describe("storing a publisher file beside the decision's raw payload", () => {
  let fake: FakeS3;

  beforeEach(() => {
    fake = startFakeS3();
  });

  afterEach(() => {
    fake.stop();
  });

  test("the bytes land at the address the envelope names them by", async () => {
    const bytes = new TextEncoder().encode("%PDF-1.4 a decision");

    const ref = await writeSourceBinary({
      family: RAW_SOURCE_FAMILY.CASE_LAW,
      sourceId: SOURCE_ID,
      bytes,
      contentType: "application/pdf",
    });

    // The address is written in the corpus location form, so a later change
    // that packs these files replaces the address and nothing else.
    const location = parseCorpusLocation(ref.location);
    expect(location.type).toBe("object");
    const stored = fake.objects.get(
      `${envBase.S3_BUCKET}/${location.type === "object" ? location.key : ""}`,
    );
    expect([...(stored?.bytes ?? [])]).toEqual([...bytes]);
    expect(stored?.contentType).toBe("application/pdf");
    expect(ref.byteLength).toBe(bytes.byteLength);
  });

  test("the reference a caller derives is the one the write produces", async () => {
    const bytes = new TextEncoder().encode("%PDF-1.4 another decision");
    const input = {
      family: RAW_SOURCE_FAMILY.CASE_LAW,
      sourceId: SOURCE_ID,
      bytes,
      contentType: "application/pdf",
    } as const;

    // What a fixture, a replay or a dry run has to state about a row before
    // the write happens, held to the write by construction rather than by a
    // second copy of the key format.
    expect(await writeSourceBinary({ ...input })).toEqual(
      sourceBinaryRef({ ...input }),
    );
  });

  test("the same file served for two decisions is stored once", async () => {
    const bytes = new TextEncoder().encode("%PDF-1.4 one document");
    const input = {
      family: RAW_SOURCE_FAMILY.CASE_LAW,
      sourceId: SOURCE_ID,
      bytes,
      contentType: "application/pdf",
    } as const;

    const first = await writeSourceBinary({ ...input });
    const second = await writeSourceBinary({ ...input });

    // Content-addressed: a docket whose separate opinion carries the same
    // file, and every later replay of either, name one object rather than a
    // copy per row.
    expect(second).toEqual(first);
    expect([...fake.objects.keys()]).toHaveLength(1);
  });
});
