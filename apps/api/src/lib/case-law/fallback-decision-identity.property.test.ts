import { expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import {
  absentDecisionTextFields,
  TEXT_ABSENCE_REASON,
} from "@/api/lib/case-law/decision-text";
import {
  decisionFallbackState,
  decisionStorageIdentity,
  fallbackDecisionIdentity,
  fallbackDecisionIdentityKey,
  parseFallbackDecisionIdentityKey,
} from "@/api/lib/case-law/fallback-decision-identity";
import { EMPTY_AST } from "@/api/lib/legal-search/ingestion-types";
import { plainTextIngestionResult } from "@/api/lib/legal-search/plain-text-assembly";

const text = fc
  .array(
    fc.oneof(
      fc.integer({ min: 0, max: 0xff_ff }),
      fc.constantFrom(58, 268, 253, 337, 34, 92),
    ),
    { minLength: 1, maxLength: 12 },
  )
  .map((units) => String.fromCodePoint(...units));

test("fallback decision keys round-trip arbitrary court docket and evidence strings", () => {
  assertProperty(
    "fallback decision keys round-trip arbitrary court docket and evidence strings",
    fc.property(text, text, text, (court, caseNumber, ecli) => {
      const identity = {
        type: "decision",
        language: "cs",
        court: { type: "court-name", name: court },
        caseNumber,
        evidence: { type: "ecli", value: ecli },
      } as const;
      const key = fallbackDecisionIdentityKey(identity);
      if (key === null) {
        return;
      }
      expect(key.length).toBeLessThanOrEqual(320);
      expect(parseFallbackDecisionIdentityKey(key)).toEqual(identity);
    }),
  );
});

test("fallback decisions differing only in court or decision evidence never share a key", () => {
  assertProperty(
    "fallback decisions differing only in court or decision evidence never share a key",
    fc.property(text, text, text, (court, suffix, caseNumber) => {
      const first = {
        type: "decision",
        language: "sk",
        court: { type: "court-name", name: court },
        caseNumber,
        evidence: { type: "ecli", value: "ECLI:SK:1" },
      } as const;
      const key = fallbackDecisionIdentityKey(first);
      expect(key).not.toBeNull();
      expect(key).not.toBe(
        fallbackDecisionIdentityKey({
          ...first,
          court: { type: "court-name", name: court + suffix },
        }),
      );
      expect(key).not.toBe(
        fallbackDecisionIdentityKey({
          ...first,
          evidence: { type: "ecli", value: "ECLI:SK:2" },
        }),
      );
    }),
  );
});

test("public dockets stay separate across courts and across decisions at the same court", () => {
  const regional = (court: string) =>
    fallbackDecisionIdentityKey(
      fallbackDecisionIdentity({
        language: "cs",
        court,
        caseNumber: "104 C 16/2024",
        sheetNumber: "1",
      }),
    );
  expect(regional("Okresní soud v Chrudimi")).not.toBe(
    regional("Okresní soud v Jihlavě"),
  );
  const slovak = (court: string, decisionDate: string) =>
    fallbackDecisionIdentityKey(
      fallbackDecisionIdentity({
        language: "sk",
        court,
        caseNumber: "0Pu/1/2025",
        decisionDate,
        decisionType: "Uznesenie",
      }),
    );
  const keys = [
    slovak("Okresný súd Bardejov", "2025-04-18"),
    slovak("Mestský súd Košice", "2025-04-18"),
    slovak("Mestský súd Košice", "2025-05-28"),
  ];
  expect(keys.every((key) => key !== null)).toBe(true);
  expect(new Set(keys).size).toBe(3);
});

test("no decision evidence or no known court describes a cohort rather than one decision", () => {
  expect(
    fallbackDecisionIdentity({
      language: "sk",
      court: "Mestský súd Košice",
      caseNumber: "0Pu/1/2025",
    }).type,
  ).toBe("multiple-decisions");
  expect(
    fallbackDecisionIdentity({
      language: "sk",
      court: "",
      caseNumber: "0Pu/1/2025",
      decisionDate: "2025-04-18",
    }).type,
  ).toBe("multiple-decisions");
  expect(
    parseFallbackDecisionIdentityKey("case-number:sk:0Pu/1/2025"),
  ).toBeNull();
  expect(
    fallbackDecisionIdentityKey(
      fallbackDecisionIdentity({
        language: "sk",
        court: "Ž".repeat(321),
        caseNumber: "0Pu/1/2025",
        decisionDate: "2025-04-18",
      }),
    ),
  ).toBeNull();
});

const publishedDecision = (fulltext: string, decisionDate = "2025-04-18") =>
  plainTextIngestionResult({
    caseNumber: "0Pu/1/2025",
    language: "sk",
    country: "SVK",
    court: "Mestský súd Košice",
    decisionDate,
    decisionType: "Uznesenie",
    fulltext,
    rawHash: "fixture",
    metadata: {},
    documentAst: EMPTY_AST,
    textFields: absentDecisionTextFields(TEXT_ABSENCE_REASON.NOT_PUBLISHED),
  });

test("same-day same-type weak decisions deduplicate by document and preserve different content", () => {
  const first = decisionStorageIdentity(publishedDecision("Prvé uznesenie."));
  const replay = decisionStorageIdentity(publishedDecision("Prvé uznesenie."));
  const sibling = decisionStorageIdentity(
    publishedDecision("Druhé uznesenie."),
  );
  expect(first.type).toBe("content");
  expect(replay).toEqual(first);
  if (first.type !== "content" || sibling.type !== "content") {
    return expect.unreachable("Weak source evidence must use content identity");
  }
  expect(sibling.cohortKey).toBe(first.cohortKey);
  expect(sibling.contentHash).not.toBe(first.contentHash);
  expect(
    decisionFallbackState({ storage: first }).columns.fallbackIdentityKey,
  ).toBeNull();
  expect(
    decisionFallbackState({ storage: sibling }).columns.fallbackIdentityKey,
  ).toBeNull();
});

test("weak metadata changes move the cohort without changing document identity", () => {
  const first = decisionStorageIdentity(
    publishedDecision("Rovnaké uznesenie.", "2025-04-18"),
  );
  const corrected = decisionStorageIdentity(
    publishedDecision("Rovnaké uznesenie.", "2025-05-28"),
  );
  if (first.type !== "content" || corrected.type !== "content") {
    return expect.unreachable("Weak source evidence must use content identity");
  }
  expect(first.cohortKey).not.toBe(corrected.cohortKey);
  expect(first.contentHash).toBe(corrected.contentHash);
});

test("strong ECLI identity excludes date and type from the unique key", () => {
  const first = fallbackDecisionIdentity({
    language: "cs",
    court: "Okresní soud v Chrudimi",
    caseNumber: "104 C 16/2024",
    ecli: "ECLI:CZ:OSCR:2025:104.C.16.2024.1",
    decisionDate: "2025-04-18",
    decisionType: "rozsudek",
  });
  const corrected = fallbackDecisionIdentity({
    language: "cs",
    court: "Okresní soud v Chrudimi",
    caseNumber: "104 C 16/2024",
    ecli: "ECLI:CZ:OSCR:2025:104.C.16.2024.1",
    decisionDate: "2025-05-28",
    decisionType: "usnesení",
  });
  expect(first.type).toBe("decision");
  expect(fallbackDecisionIdentityKey(first)).toBe(
    fallbackDecisionIdentityKey(corrected),
  );
});

test("metadata-only publications retain the different stated records", () => {
  const first = decisionStorageIdentity(publishedDecision("", "2025-04-18"));
  const second = decisionStorageIdentity(publishedDecision("", "2025-05-28"));
  if (first.type !== "content" || second.type !== "content") {
    return expect.unreachable(
      "Weak publication records must use content identity",
    );
  }
  expect(first.contentHash).not.toBe(second.contentHash);
  expect(decisionStorageIdentity(publishedDecision("", "2025-04-18"))).toEqual(
    first,
  );
});

test("publication identity remains stable across document enrichment", () => {
  const metadata = decisionStorageIdentity(publishedDecision(""));
  const detail = decisionStorageIdentity(publishedDecision("Prvé uznesenie."));
  if (metadata.type !== "content" || detail.type !== "content") {
    return expect.unreachable(
      "Weak observations must have publication fingerprints",
    );
  }
  expect(metadata.publicationHash).toBe(detail.publicationHash);
  expect(metadata.documentState).toBe("metadata-only");
  expect(detail.documentState).toBe("document");
  expect(metadata.contentHash).not.toBe(detail.contentHash);
});

test("textless same-cohort publications retain distinct stated metadata", () => {
  const first = decisionStorageIdentity(
    plainTextIngestionResult({
      ...publishedDecision(""),
      metadata: { record: "first" },
    }),
  );
  const second = decisionStorageIdentity(
    plainTextIngestionResult({
      ...publishedDecision(""),
      metadata: { record: "second" },
    }),
  );
  if (first.type !== "content" || second.type !== "content") {
    return expect.unreachable("Expected weak records");
  }
  expect(first.cohortKey).toBe(second.cohortKey);
  expect(first.contentHash).not.toBe(second.contentHash);
});
