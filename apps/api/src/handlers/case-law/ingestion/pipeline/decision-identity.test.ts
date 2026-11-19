/**
 * The court a decision reaches the write path with.
 *
 * Every adapter's decisions pass `observeDecision`, so it is where a printed
 * court name becomes a court identity: a Czech or Slovak name is read onto
 * its directory court and the row is written under that court's id and
 * official name, with the printed name beside them; a name the directory
 * cannot place is this decision's rejection, never a new court.
 */

import { Result } from "better-result";
import { expect, test } from "bun:test";

import { observeDecision } from "@/api/handlers/case-law/ingestion/pipeline/decision-identity";
import { createSafeId } from "@/api/lib/branded-types";
import { DecisionCourtIdentityError } from "@/api/lib/case-law/decision-court-identity";
import {
  absentDecisionTextFields,
  TEXT_ABSENCE_REASON,
} from "@/api/lib/case-law/decision-text";
import { fallbackDecisionIdentityKey } from "@/api/lib/case-law/fallback-decision-identity";
import { EMPTY_AST } from "@/api/lib/legal-search/ingestion-types";
import { plainTextIngestionResult } from "@/api/lib/legal-search/plain-text-assembly";

const sourceId = createSafeId<"caseLawSource">();

const decision = ({
  country,
  court,
  metadata = {},
  sourceDocumentId = "doc-1",
}: {
  country: string;
  court: string;
  metadata?: Record<string, string>;
  /** Null for a decision its publisher gives no id. */
  sourceDocumentId?: string | null;
}) =>
  plainTextIngestionResult({
    caseNumber: "30 A 12/2020",
    ...(sourceDocumentId === null ? {} : { sourceDocumentId }),
    ecli: "ECLI:CZ:KSHK:2020:30.A.12.2020.1",
    court,
    country,
    language: country === "SVK" ? "sk" : "cs",
    decisionDate: "2020-05-04",
    decisionType: "rozsudek",
    fulltext: "Rozsudek.",
    metadata,
    textFields: absentDecisionTextFields(TEXT_ABSENCE_REASON.NOT_PUBLISHED),
    rawHash: "hash-1",
    documentAst: EMPTY_AST,
  });

const observed = (input: ReturnType<typeof decision>) =>
  observeDecision({ input, sourceId });

const PARDUBICE = "Krajský soud v Hradci Králové – pobočka v Pardubicích";

test("two publishers' spellings of one court reach the write path as one court", () => {
  const regional = observed(
    decision({
      country: "CZE",
      court: "Krajský soud v Hradci Králové, pobočka Pardubice",
      metadata: { court: "Krajský soud v Hradci Králové, pobočka Pardubice" },
    }),
  ).unwrap().observed;
  const supreme = observed(
    decision({
      country: "CZE",
      court: PARDUBICE,
      metadata: { court: PARDUBICE },
    }),
  ).unwrap().observed;
  for (const written of [regional, supreme]) {
    expect(String(written.court)).toBe(PARDUBICE);
    expect(written.courtId).toBe("KSHKPA");
  }
  // The printed name stays beside the official one.
  expect(regional.metadata).toMatchObject({
    court: "Krajský soud v Hradci Králové, pobočka Pardubice",
  });
});

test("a printed name the adapter did not keep is kept by the boundary", () => {
  const written = observed(
    decision({ country: "SVK", court: "Okresný súd Žiar n/H" }),
  ).unwrap().observed;
  expect(String(written.court)).toBe("Okresný súd Žiar nad Hronom");
  expect(written.courtId).toBe("OSZH");
  expect(written.metadata).toMatchObject({ court: "Okresný súd Žiar n/H" });
});

test("a printed name the directory cannot place is the decision's rejection", () => {
  const rejected = observed(
    decision({ country: "CZE", court: "Neznámý soud 58" }),
  );
  if (!Result.isError(rejected)) {
    throw new TypeError("an unplaceable court was admitted");
  }
  expect(rejected.error).toBeInstanceOf(DecisionCourtIdentityError);
  expect(rejected.error).toMatchObject({
    country: "CZE",
    court: "Neznámý soud 58",
    reason: "unknown-name",
  });
});

test("a jurisdiction identified by name keeps the name it printed and stores no id", () => {
  const written = observed(
    decision({ country: "POL", court: "Sąd Najwyższy" }),
  ).unwrap().observed;
  expect(String(written.court)).toBe("Sąd Najwyższy");
  expect(written.courtId).toBeUndefined();
});

test("a printed-name decision without a publisher id keeps a key by its official name", () => {
  // Rows stored before courts had ids are found by the name they carry, so
  // the key names the court as the official name does, not as its id.
  const storage = observed(
    decision({
      country: "CZE",
      court: "Krajský soud v Hradci Králové, pobočka Pardubice",
      sourceDocumentId: null,
    }),
  ).unwrap().storageIdentity;
  if (storage.type !== "strong") {
    throw new Error(`expected a strong fallback identity, got ${storage.type}`);
  }
  expect(storage.identity.court).toEqual({
    type: "court-name",
    name: PARDUBICE,
  });
  const official = observed(
    decision({ country: "CZE", court: PARDUBICE, sourceDocumentId: null }),
  ).unwrap().storageIdentity;
  expect(
    official.type === "strong"
      ? fallbackDecisionIdentityKey(official.identity)
      : null,
  ).toBe(storage.key);
});
