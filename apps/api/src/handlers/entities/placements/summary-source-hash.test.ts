import { expect, test } from "bun:test";

import { createSha256 as legacyHasher } from "@stll/sha256/node";

import { toSafeId } from "@/api/lib/branded-types";

import { hashSummarySource } from "./summary-source-hash";

for (const text of [
  "",
  "abc",
  "Příliš žluťoučký kůň 📄 中文\u0000",
  "e\u0301",
]) {
  test(`persisted placement summaries preserve the legacy source byte stream: ${JSON.stringify(text)}`, () => {
    const entityVersionId = toSafeId<"entityVersion">(
      "00000000-0000-4000-8000-000000000001",
    );
    for (const searchDocumentUpdatedAt of [
      null,
      new Date("2026-10-08T06:00:00Z"),
    ]) {
      const old = legacyHasher()
        .update(entityVersionId)
        .update("\n")
        .update(text)
        .update("\n")
        .update(text)
        .update("\n")
        .update(searchDocumentUpdatedAt?.toISOString() ?? "")
        .digest("hex");
      expect(
        hashSummarySource({
          entityVersionId,
          originalName: text,
          indexedTitle: text,
          searchDocumentUpdatedAt,
        }),
      ).toBe(old);
    }
  });
}
