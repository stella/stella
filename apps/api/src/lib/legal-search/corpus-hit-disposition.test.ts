import { expect, test } from "bun:test";

import { isUuid } from "@stll/uuid-codec";

import { classifyCorpusHit } from "@/api/lib/legal-search/corpus-hit-disposition";
import type { CorpusIndexHit } from "@/api/lib/legal-search/corpus-index-client";

const readIdentity = (hit: CorpusIndexHit) => {
  const id = hit["document_id"];
  return typeof id === "string" && isUuid(id) ? id : null;
};

test("corpus identities classify absent fields and invalid values as malformed", () => {
  for (const hit of [{}, { document_id: null }]) {
    expect(classifyCorpusHit(hit, readIdentity)).toEqual({
      type: "malformed",
    });
  }
  for (const documentId of ["", "unstructured-id", 7, false, {}]) {
    expect(
      classifyCorpusHit({ document_id: documentId }, readIdentity),
    ).toEqual({
      type: "malformed",
    });
  }
  const id = "00000000-0000-4000-8000-000000000001";
  expect(classifyCorpusHit({ document_id: id }, readIdentity)).toEqual({
    type: "valid",
    id,
  });
});

test("the identity reader remains authoritative for the selected corpus", () => {
  const hit = { document_id: "document-key" };
  expect(classifyCorpusHit(hit, () => "canonical-key")).toEqual({
    type: "valid",
    id: "canonical-key",
  });
  expect(classifyCorpusHit(hit, () => null)).toEqual({
    type: "malformed",
  });
});
