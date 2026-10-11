import { expect, test } from "bun:test";

import { createSha256 as createLegacyNodeHash } from "@stll/sha256/node";

import { extractStamp, injectStamp } from "@/api/lib/docx-stamp";
import { storedDocumentBytes } from "@/api/lib/files/stored-document-bytes";

import { hashDesktopEditCheckpoint } from "./checkpoint-desktop-edit-session";
import { hashFolioCollabCheckpoint } from "./checkpoint-folio-collab-room";
import { hashFinalizedDesktopEditBytes } from "./finalize-desktop-edit-session";
import { hashPublishedFolioCollabBytes } from "./publish-folio-collab-version";

const storedDocxFixture = new URL(
  "../case-law/ingestion/parsers/__fixtures__/hu-bhgy-decision.docx",
  import.meta.url,
);

// The Node owner delegates to createHash("sha256"), independently of Bun.
const legacyDigest = (bytes: Uint8Array) =>
  createLegacyNodeHash().update(bytes).digest("hex");

const expectPersistedDigestParity = (bytes: Uint8Array) => {
  const expected = legacyDigest(bytes);
  expect(hashDesktopEditCheckpoint(Uint8Array.from(bytes).buffer)).toBe(
    expected,
  );
  expect(hashFolioCollabCheckpoint(bytes)).toBe(expected);
  expect(hashFinalizedDesktopEditBytes(bytes)).toBe(expected);
  expect(hashPublishedFolioCollabBytes(bytes)).toBe(expected);
};

test.each(["", "ordinary", "Žluťoučký kůň Łódź 📄", "e\u0301"])(
  "checkpoint and transformed publication hashes retain legacy UTF-8 bytes: %j",
  (text) => {
    expectPersistedDigestParity(new TextEncoder().encode(text));
  },
);

test("checkpoint and transformed publication hashes retain real stored DOCX bytes", async () => {
  const bytes = new Uint8Array(await Bun.file(storedDocxFixture).arrayBuffer());
  expect(bytes.byteLength).toBeGreaterThan(0);
  expectPersistedDigestParity(bytes);
});

test("finalization and publication hash the rewritten archive after removing a document reference", async () => {
  const submitted = new Uint8Array(
    await injectStamp(
      await Bun.file(storedDocxFixture).arrayBuffer(),
      "TEST-001-1",
      "abcdefgh",
      "https://example.test",
    ),
  );
  const stored = await storedDocumentBytes(submitted);
  expect(stored.strippedArchive).not.toBeNull();
  expect(stored.bytes).not.toEqual(submitted);
  const expected = legacyDigest(stored.bytes);
  expect(expected).not.toBe(legacyDigest(submitted));
  expect(await extractStamp(Uint8Array.from(stored.bytes).buffer)).toEqual({
    stamp: null,
    verificationCode: null,
  });
  expect(hashFinalizedDesktopEditBytes(stored.bytes)).toBe(expected);
  expect(hashPublishedFolioCollabBytes(stored.bytes)).toBe(expected);
});
