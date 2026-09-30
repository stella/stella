import { panic } from "better-result";
import { describe, expect, test } from "bun:test";

import {
  encodeSourceRawEnvelope,
  decodeSourceRawEnvelope,
  SOURCE_RAW_ENVELOPE_CONTENT_TYPE,
} from "@/api/handlers/case-law/ingestion/adapter";
import { skUsAdapter } from "@/api/handlers/case-law/ingestion/adapters/sk-us";
import { readGzipJson } from "@/api/lib/gzip-json";
import { isRecord } from "@/api/lib/type-guards";

const fixture = async () => {
  const payload = await readGzipJson(
    new URL("__fixtures__/sk-us-collection.json.gz", import.meta.url),
  );
  if (
    !isRecord(payload) ||
    !isRecord(payload["decisions"]) ||
    !isRecord(payload["collection"])
  ) {
    return panic(
      "The collection fixture must contain both publisher responses",
    );
  }
  const decisions = payload["decisions"]["documents"];
  const entries = payload["collection"]["documents"];
  if (!Array.isArray(decisions) || !Array.isArray(entries)) {
    return panic("The collection fixture must contain document lists");
  }
  const listing: unknown = decisions.at(0);
  const entry: unknown = entries.at(0);
  if (!isRecord(listing) || !isRecord(entry)) {
    return panic("The collection fixture must contain both document rows");
  }
  return { listing, entry };
};

type ReplayOptions = {
  listing: Record<string, unknown>;
  entries?: readonly Record<string, unknown>[];
  siblings?: readonly Record<string, unknown>[];
  collectionTotal?: number;
};

const replay = async ({
  listing,
  entries,
  siblings = [listing],
  collectionTotal,
}: ReplayOptions) => {
  const reparse = skUsAdapter.reparseStoredRaw;
  if (
    reparse === undefined ||
    typeof listing["mkRSAPNumberOfFile"] !== "string"
  ) {
    return panic("The adapter and fixture must support stored replay");
  }
  const sourceRaw = encodeSourceRawEnvelope({
    listing: JSON.stringify(listing),
    facets: JSON.stringify({ documents: siblings, numFound: siblings.length }),
    ...(entries === undefined
      ? {}
      : {
          "collection-listing": JSON.stringify({
            documents: entries,
            numFound: collectionTotal ?? entries.length,
          }),
        }),
  });
  const outcome = await reparse({
    raw: new TextEncoder().encode(sourceRaw),
    contentType: SOURCE_RAW_ENVELOPE_CONTENT_TYPE,
    caseNumber: listing["mkRSAPNumberOfFile"],
    sourceDocumentId: null,
    language: "sk",
    court: "Ústavný súd SR",
    ecli: null,
    decisionDate: null,
    decisionType: null,
    sourceUrl: null,
    documentUrl: null,
    metadata: {},
  });
  if (outcome.type !== "parsed") {
    return panic("The collection fixture must be reparsable");
  }
  return outcome.result;
};

describe("ÚS collection identity and publication", () => {
  test("joins a separate collection document without changing the decision identity or stated metadata", async () => {
    const { listing, entry } = await fixture();
    expect(entry["documentId"]).not.toBe(listing["documentId"]);
    expect(entry["mkClauseText"]).toBeString();
    const withoutClauses = {
      ...listing,
      mkClauseTitle: null,
      mkClauseText: null,
    };
    const result = await replay({ listing: withoutClauses, entries: [entry] });
    expect(result.sourceDocumentId).toBe(listing["documentId"]);
    expect(result.ecli).toBe(listing["mkECLI"]);
    expect(result.textFields.headnote).toEqual({
      type: "present",
      text: entry["mkClauseTitle"],
    });
    expect(result.textFields.legalSentence).toEqual({
      type: "present",
      text: entry["mkClauseText"],
    });
    expect(result.metadata["includeToZnaU"]).toBe(listing["mkIncludeToZnaU"]);
    expect(result.metadata["publishedInCollection"]).toEqual({
      status: "published",
      documentId: entry["documentId"],
      number: entry["mkLawReportsNumber"],
      volume: entry["mkVolumeOfLawReports"],
      year: entry["mkYearOfLawReports"],
      period: entry["mkTimePeriodZNaU"],
    });
    expect(await replay({ listing: withoutClauses, entries: [entry] })).toEqual(
      result,
    );
  });

  test("never guesses among competing entries or decisions, regardless of listing order", async () => {
    const { listing, entry } = await fixture();
    const withoutClauses = {
      ...listing,
      mkClauseTitle: null,
      mkClauseText: null,
      mkIncludeToZnaU: null,
    };
    const otherEntry = {
      ...entry,
      documentId: "11111111-2222-4333-8444-555555555555",
    };
    const otherDecision = {
      ...withoutClauses,
      documentId: "99999999-2222-4333-8444-555555555555",
    };
    for (const entries of [
      [entry, otherEntry],
      [otherEntry, entry],
    ]) {
      const result = await replay({ listing: withoutClauses, entries });
      expect(result.textFields.headnote.type).toBe("absent");
      expect(result.metadata["publishedInCollection"]).toEqual({
        status: "not_stated",
        reason: "ambiguous_identity",
      });
    }
    for (const siblings of [
      [withoutClauses, otherDecision],
      [otherDecision, withoutClauses],
    ]) {
      const result = await replay({
        listing: withoutClauses,
        entries: [entry],
        siblings,
      });
      expect(result.textFields.legalSentence.type).toBe("absent");
      expect(result.metadata["publishedInCollection"]).toEqual({
        status: "not_stated",
        reason: "ambiguous_identity",
      });
    }
  });

  test("requires the same docket, date and decision kind and a complete listing", async () => {
    const { listing, entry } = await fixture();
    const withoutClauses = {
      ...listing,
      mkClauseTitle: null,
      mkClauseText: null,
      mkIncludeToZnaU: null,
    };
    for (const changed of [
      { ...entry, mkRSAPNumberOfFile: "II. ÚS 64/2026" },
      { ...entry, mkDateOfDecision: "06/11/2026 00:00:00" },
      {
        ...entry,
        mkFormOfDecision: "Uznesenie",
        mkTypeOfDecision: ["Uznesenie"],
      },
    ]) {
      const result = await replay({
        listing: withoutClauses,
        entries: [changed],
      });
      expect(result.metadata["publishedInCollection"]).toEqual({
        status: "not_stated",
        reason: "no_matching_entry",
      });
    }
    const truncated = await replay({
      listing: withoutClauses,
      entries: [entry],
      collectionTotal: 2,
    });
    expect(truncated.metadata["publishedInCollection"]).toEqual({
      status: "not_stated",
      reason: "incomplete_listing",
    });
  });

  test("keeps absence, selection and publisher placeholders distinct without inventing ECLI", async () => {
    const { listing, entry } = await fixture();
    const unpublished = {
      ...listing,
      mkECLI: null,
      mkClauseTitle: null,
      mkClauseText: null,
      mkIncludeToZnaU: null,
    };
    const absent = await replay({ listing: unpublished, entries: [] });
    expect(absent.ecli).toBeUndefined();
    expect(absent.metadata["ecliAvailability"]).toEqual({
      status: "not_published",
    });
    expect(absent.textFields.legalSentence).toEqual({
      type: "absent",
      reason: "not_published",
    });
    const selected = await replay({
      listing: { ...unpublished, mkIncludeToZnaU: true },
      entries: [],
    });
    expect(selected.metadata["publishedInCollection"]).toEqual({
      status: "selected",
      reason: "no_matching_entry",
    });
    const placeholder = await replay({
      listing: { ...unpublished, mkClauseText: "- bez právnej vety -" },
      entries: [{ ...entry, mkClauseText: null }],
    });
    expect(placeholder.textFields.legalSentence).toEqual({
      type: "absent",
      reason: "publisher_placeholder",
    });
  });
  test("rejects malformed collection field types while preserving the captured response", async () => {
    const { listing, entry } = await fixture();
    const withoutClauses = {
      ...listing,
      mkClauseTitle: null,
      mkClauseText: null,
      mkIncludeToZnaU: null,
    };
    for (const changed of [
      { ...entry, mkClauseTitle: 123 },
      { ...entry, mkClauseText: ["sentence"] },
      { ...entry, mkYearOfLawReports: "2026" },
      { ...entry, mkYearOfLawReports: 2026.5 },
      { ...entry, mkTypeOfDecision: [123] },
      { ...entry, mkFormOfDecision: true },
      { ...entry, mkDateOfDecision: 20_260_610 },
      { ...entry, mkLawReportsNumber: {} },
      { ...entry, mkVolumeOfLawReports: [] },
      { ...entry, mkTimePeriodZNaU: 1 },
    ]) {
      const result = await replay({
        listing: withoutClauses,
        entries: [changed],
      });
      expect(result.metadata["publishedInCollection"]).toEqual({
        status: "not_stated",
        reason: "invalid_listing",
      });
      expect(result.textFields.headnote).toEqual({
        type: "absent",
        reason: "not_published",
      });
      const captured = decodeSourceRawEnvelope(result.sourceRaw ?? "");
      expect(
        JSON.parse(captured?.["collection-listing"] ?? "null"),
      ).toMatchObject({ documents: [changed] });
    }
  });

  test("distinguishes an omitted ECLI from a publisher-stated null", async () => {
    const { listing } = await fixture();
    const missing = { ...listing };
    delete missing["mkECLI"];
    expect(Object.hasOwn(missing, "mkECLI")).toBe(false);
    const absentKey = await replay({ listing: missing, entries: [] });
    expect(absentKey.metadata["ecliAvailability"]).toEqual({
      status: "not_stated",
    });
    const statedNull = await replay({
      listing: { ...missing, mkECLI: null },
      entries: [],
    });
    expect(statedNull.metadata["ecliAvailability"]).toEqual({
      status: "not_published",
    });
  });

  test("keeps collection-loss reasons for every publisher inclusion state", async () => {
    const { listing } = await fixture();
    for (const [includeToZnaU, status] of [
      [true, "selected"],
      [false, "not_included"],
      [null, "not_stated"],
    ] as const) {
      const result = await replay({
        listing: { ...listing, mkIncludeToZnaU: includeToZnaU },
      });
      expect(result.metadata["publishedInCollection"]).toEqual({
        status,
        reason: "unavailable",
      });
    }
  });
});
