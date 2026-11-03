import { describe, expect, test } from "bun:test";

import { hasUsableAst } from "@stll/legal-ast/document-ast";

import { skCourtsAdapter } from "@/api/handlers/case-law/ingestion/adapters/sk-courts";
import { skCourtsRetention } from "@/api/handlers/case-law/ingestion/retention/sources/sk-courts";
import { readGzipJson } from "@/api/lib/gzip-json";
import { isRecord, isUnknownArray } from "@/api/lib/type-guards";

const ADAPTER_FIXTURES = new URL(
  "../../adapters/__fixtures__/",
  import.meta.url,
);

/** Every decision the recorded page stores, as the crawl stored it. */
const recordedDecisions = async (): Promise<
  { caseNumber: string; sourceRaw: string; sourceRawContentType: string }[]
> => {
  const recording = await readGzipJson(
    new URL("sk-courts-page.json.gz", ADAPTER_FIXTURES),
  );
  const page = isRecord(recording) ? recording["page"] : undefined;
  const decisions = isRecord(page) ? page["decisions"] : undefined;
  return (isUnknownArray(decisions) ? decisions : []).flatMap((decision) =>
    isRecord(decision) &&
    typeof decision["caseNumber"] === "string" &&
    typeof decision["sourceRaw"] === "string" &&
    typeof decision["sourceRawContentType"] === "string"
      ? [
          {
            caseNumber: decision["caseNumber"],
            sourceRaw: decision["sourceRaw"],
            sourceRawContentType: decision["sourceRawContentType"],
          },
        ]
      : [],
  );
};

describe("sk-courts retention policy", () => {
  test("is declared unparsed, because the adapter stores listing metadata", () => {
    expect(skCourtsRetention).toEqual({
      type: "unparsed",
      reason: "metadata-only",
    });
  });

  test("no decision the adapter builds from a recorded page carries a document", async () => {
    const decisions = await recordedDecisions();
    expect(decisions.length).toBeGreaterThan(0);
    const reparse = skCourtsAdapter.reparseStoredRaw;
    if (reparse === undefined) {
      throw new TypeError("sk-courts must support stored replay");
    }

    for (const stored of decisions) {
      const outcome = await reparse({
        raw: new TextEncoder().encode(stored.sourceRaw),
        contentType: stored.sourceRawContentType,
        caseNumber: stored.caseNumber,
        sourceDocumentId: null,
        language: "sk",
        court: "",
        ecli: null,
        decisionDate: null,
        decisionType: null,
        sourceUrl: null,
        documentUrl: null,
        metadata: {},
      });
      // An unparsed policy that met a built document would report it as
      // unverifiable on every crawl; this is the claim the policy rests on.
      expect(
        outcome.type === "parsed" && hasUsableAst(outcome.result.documentAst),
      ).toBe(false);
    }
  });
});
