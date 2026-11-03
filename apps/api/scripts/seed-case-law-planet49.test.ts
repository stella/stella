import { expect, test } from "bun:test";

import {
  fixtureDecisionRow,
  fixtureSourceRow,
  validateFixtureDecisionIdentities,
} from "./seed-case-law";
import { planet49CaseLawFixture } from "./seed-case-law-planet49";

test("document identities separate every language and role while reseeding stays stable", () => {
  const fixture = planet49CaseLawFixture();
  const source = fixtureSourceRow(fixture.source);
  const rows = () =>
    fixture.decisions.map((decision) =>
      fixtureDecisionRow({
        adapterKey: fixture.source.adapter_key,
        sourceId: source.id,
        decision,
      }),
    );
  const first = rows();
  expect(first).toHaveLength(46);
  expect(first).toEqual(rows());
  expect(new Set(first.map(({ id }) => id)).size).toBe(46);
  expect(
    new Set(first.map(({ sourceDocumentId }) => sourceDocumentId)).size,
  ).toBe(46);
  expect(
    new Set(first.map(({ docketFamilyKey }) => docketFamilyKey)).size,
  ).toBe(1);
  expect(first.every(({ docketFamilyKey }) => docketFamilyKey !== null)).toBe(
    true,
  );
  for (const type of ["judgment", "opinion"]) {
    const documents = first.filter(({ decisionType }) => decisionType === type);
    expect(documents).toHaveLength(23);
    expect(new Set(documents.map(({ language }) => language)).size).toBe(23);
    expect(
      new Set(documents.map(({ languageGroupKey }) => languageGroupKey)).size,
    ).toBe(1);
  }
  expect(
    new Set(first.map(({ languageGroupKey }) => languageGroupKey)).size,
  ).toBe(2);
  expect(
    first.every(({ fulltext }) =>
      fulltext.includes("Synthetic presentation fixture"),
    ),
  ).toBe(true);
});

test("a repeated fixture identity fails before it can resolve to another document", () => {
  const fixture = planet49CaseLawFixture();
  expect(() => validateFixtureDecisionIdentities([fixture, fixture])).toThrow(
    "Ambiguous fixture decision identity",
  );
  const anonymous = {
    ...fixture,
    decisions: fixture.decisions.map((decision) => ({
      ...decision,
      ecli: null,
      source_hash: null,
    })),
  };
  expect(() => validateFixtureDecisionIdentities([anonymous])).toThrow(
    "Ambiguous fixture decision identity",
  );
});
