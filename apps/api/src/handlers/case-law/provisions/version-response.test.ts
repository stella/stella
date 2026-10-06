import { expect, test } from "bun:test";
import fc from "fast-check";

import { STATED_DATE_RELATIONS } from "@stll/api-contract/provision-applied-version";
import { provisionVersionAsOf } from "@stll/api-contract/provision-version-basis";
import { assertProperty } from "@stll/property-testing";

import type { caseLawProvisionCitations } from "@/api/db/schema";

import type { PROVISION_VERSION_COLUMNS } from "./version-response";
import { projectProvisionVersion } from "./version-response";

type VersionRow = Pick<
  typeof caseLawProvisionCitations.$inferSelect,
  keyof typeof PROVISION_VERSION_COLUMNS | "versionValidFrom"
>;
const legacy = {
  appliedVersionBasis: null,
  appliedVersionDate: null,
  appliedVersionDateRelation: null,
  appliedVersionAmendmentWorkIdentifier: null,
  appliedVersionExpressionDate: null,
  appliedVersionExpressionEli: null,
  versionEvidenceStart: null,
  versionEvidenceEnd: null,
  versionEvidenceKind: null,
  versionValidFrom: "2020-01-01",
} satisfies VersionRow;

test("applied version selection never inherits the inferred decision-date candidate", () => {
  assertProperty(
    "applied version selection never inherits the inferred decision-date candidate",
    fc.property(fc.integer({ min: 2000, max: 2099 }), (year) => {
      const versionValidFrom = `${year}-01-01`;
      const candidate = { ...legacy, versionValidFrom };
      const absent = projectProvisionVersion({
        ...candidate,
        appliedVersionBasis: "not_stated",
      });
      expect(absent.versionBasis).toEqual({ type: "not_stated" });
      expect(absent.versionValidFrom).toBeNull();
      expect(provisionVersionAsOf(absent, `${year}-06-01`)).toBeNull();
      expect(absent.inferredVersionCandidate).toEqual({
        type: "inferred",
        kind: "decision_date",
        versionValidFrom,
      });
      const amendment = projectProvisionVersion({
        ...candidate,
        appliedVersionBasis: "stated_version",
        appliedVersionAmendmentWorkIdentifier: "303/2013 Sb.",
        versionEvidenceStart: 4,
        versionEvidenceEnd: 42,
        versionEvidenceKind: "stated_version",
      });
      expect(provisionVersionAsOf(amendment, versionValidFrom)).toBeNull();
      const stated = projectProvisionVersion({
        ...candidate,
        appliedVersionBasis: "stated_date",
        appliedVersionDate: "2013-12-31",
        appliedVersionDateRelation: "until",
        versionEvidenceStart: 4,
        versionEvidenceEnd: 42,
        versionEvidenceKind: "stated_date",
      });
      expect(provisionVersionAsOf(stated, versionValidFrom)).toBeNull();
      expect(stated.versionValidFrom).toBeNull();
      expect(stated.versionBasis).toEqual({
        type: "stated_date",
        date: "2013-12-31",
        relation: "until",
        expression: null,
        evidence: { kind: "stated_date", start: 4, end: 42 },
      });
      const resolved = projectProvisionVersion({
        ...candidate,
        appliedVersionBasis: "stated_version",
        appliedVersionAmendmentWorkIdentifier: "303/2013 Sb.",
        appliedVersionExpressionDate: "2014-01-01",
        appliedVersionExpressionEli: "/eli/cz/sb/2012/89/2014-01-01",
        versionEvidenceStart: 4,
        versionEvidenceEnd: 42,
        versionEvidenceKind: "stated_version",
      });
      expect(provisionVersionAsOf(resolved, versionValidFrom)).toBe(
        "2014-01-01",
      );
      expect(
        provisionVersionAsOf(projectProvisionVersion(candidate), null),
      ).toBe(versionValidFrom);
    }),
  );
});

test("resolved expression identity controls the shared selection at an amendment boundary", () => {
  const stated = projectProvisionVersion({
    ...legacy,
    appliedVersionBasis: "stated_date",
    appliedVersionDate: "2014-01-01",
    appliedVersionDateRelation: "until",
    appliedVersionExpressionDate: "2013-01-01",
    appliedVersionExpressionEli: "/eli/2013-01-01",
    versionEvidenceStart: 0,
    versionEvidenceEnd: 42,
    versionEvidenceKind: "stated_date",
  });
  expect(stated.versionValidFrom).toBe("2013-01-01");
  expect(provisionVersionAsOf(stated, "2020-01-01")).toBe(
    stated.versionValidFrom,
  );
  expect(stated.versionBasis).toMatchObject({
    type: "stated_date",
    date: "2014-01-01",
    relation: "until",
  });
});

test("an unresolved stated date selects its own date only when the wording is in force on it", () => {
  // At an amendment boundary, "until 2014-01-01" may name the wording that ends
  // there, so selecting the expression starting that day would be wrong.
  const selections = STATED_DATE_RELATIONS.map((relation) => {
    const stated = projectProvisionVersion({
      ...legacy,
      appliedVersionBasis: "stated_date",
      appliedVersionDate: "2014-01-01",
      appliedVersionDateRelation: relation,
      versionEvidenceStart: 0,
      versionEvidenceEnd: 42,
      versionEvidenceKind: "stated_date",
    });
    expect(stated.versionValidFrom).toBe(
      provisionVersionAsOf(stated, "2020-01-01"),
    );
    return [relation, stated.versionValidFrom];
  });
  expect(Object.fromEntries(selections)).toEqual({
    on: "2014-01-01",
    from: "2014-01-01",
    until: null,
  });
});
