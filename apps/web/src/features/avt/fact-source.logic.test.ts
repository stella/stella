import { describe, expect, test } from "bun:test";

import { factId, makeFact } from "@/features/avt/avt.test-fixtures";
import {
  evidenceQuoteSource,
  evidenceSourceDocumentName,
} from "@/features/avt/fact-source.logic";
import type { EvidenceFact } from "@/features/avt/types";
import { toSafeId } from "@/lib/safe-id";

const documentId = factId(90);
const pinned: EvidenceFact["sources"][number] = {
  sourceEntityId: documentId,
  sourceEntityVersionId: toSafeId<"entityVersion">(
    "0199a3c4-5b6d-7e8f-9a0b-000000000091",
  ),
  locator: { type: "pdf-page", pageNumber: 488 },
  quote: null,
};

const file = (name: string | null) => ({
  entityId: documentId,
  name,
  fileName: "email-bundle.pdf",
});

describe("evidence source names", () => {
  test("a pinned name wins over the document's current one", () => {
    expect(
      evidenceSourceDocumentName({ ...pinned, sourceName: "Email bundle" }, [
        file("Renamed bundle"),
      ]),
    ).toBe("Email bundle");
  });

  test("a run without pinned names reads the current name", () => {
    expect(evidenceSourceDocumentName(pinned, [file("Email bundle")])).toBe(
      "Email bundle",
    );
    expect(evidenceSourceDocumentName(pinned, [file(null)])).toBe(
      "email-bundle.pdf",
    );
  });

  test("names nothing once the document is gone", () => {
    expect(evidenceSourceDocumentName(pinned, [])).toBeNull();
  });
});

describe("evidence quote source", () => {
  test("selects the exact source that supplies the displayed quote", () => {
    const quotedSource: EvidenceFact["sources"][number] = {
      ...pinned,
      sourceEntityId: factId(91),
      locator: { type: "pdf-page", pageNumber: 12 },
      quote: "The quoted evidence",
    };
    const fact = makeFact(92, { sources: [pinned, quotedSource] });

    const source = evidenceQuoteSource(fact.sources);

    expect(source).toBe(quotedSource);
    expect({
      quote: source?.quote,
      documentId: source?.sourceEntityId,
      locator: source?.locator,
    }).toEqual({
      quote: quotedSource.quote,
      documentId: quotedSource.sourceEntityId,
      locator: quotedSource.locator,
    });
  });

  test("falls back to the first source when no source has a quote", () => {
    expect(
      evidenceQuoteSource([pinned, { ...pinned, sourceEntityId: factId(93) }]),
    ).toBe(pinned);
    expect(evidenceQuoteSource([])).toBeUndefined();
  });
});
