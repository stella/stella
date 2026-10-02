import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { createHash } from "node:crypto";

import { CASE_LAW_JURISDICTIONS } from "@stll/api-contract/case-law-jurisdictions";
import {
  formatProvisionKey,
  parseProvisionKey,
} from "@stll/api-contract/provision-key";
import { assertProperty } from "@stll/property-testing";

import fixture from "./__fixtures__/cz-esbirka-500-2004-par-64.json" with { type: "json" };
import provenance from "./__fixtures__/cz-esbirka-500-2004-par-64.json.provenance.json" with { type: "json" };
import {
  CZ_PROFILE,
  CZ_STATUTE_COLLECTION,
} from "./cz-provision-citation-profile";
import {
  PROVISION_CITATION_GRAMMARS,
  provisionRefOf,
} from "./provision-citation-grammars";

const grammar = PROVISION_CITATION_GRAMMARS.CZE;
const reference = fc.record({
  unit: fc.constant("section" as const),
  section: fc.integer({ min: 1, max: 9999 }),
  sectionSuffix: fc.constantFrom(null, "a", "b", "z"),
  subsection: fc.option(fc.integer({ min: 1, max: 999 }).map(String), {
    nil: null,
  }),
  letter: fc.constantFrom(null, "a", "c", "z"),
  point: fc.option(fc.integer({ min: 1, max: 999 }).map(String), { nil: null }),
  sentence: fc.constant(null),
  openEnded: fc.constant(false),
});

describe("provision identity construction", () => {
  test("generated provision references preserve identity through citation and key round-trips", () => {
    assertProperty(
      "generated provision references preserve identity through citation and key round-trips",
      fc.property(
        reference,
        fc.integer({ min: 1, max: 99_999 }),
        fc.integer({ min: 1900, max: 2100 }),
        (ref, number, year) => {
          const printed = [
            `§ ${ref.section}${ref.sectionSuffix ?? ""}`,
            ref.subsection === null ? "" : `odst. ${ref.subsection}`,
            ref.letter === null ? "" : `písm. ${ref.letter})`,
            ref.point === null ? "" : `bod ${ref.point}`,
          ]
            .filter(Boolean)
            .join(" ");
          const parsed = grammar.locateAbbreviatedProvisions(
            `${printed} s. ř. s.`,
          );
          expect(parsed).toHaveLength(1);
          expect(parsed.at(0)?.reference).toEqual(ref);
          expect(parsed.at(0)?.anchor).toBe(grammar.anchor(ref));
          const work = grammar.gazette.parse(`${number}/${year} Sb.`);
          expect(work).not.toBeNull();
          if (work === null) {
            return;
          }
          const constructed = provisionRefOf({
            jurisdiction: grammar.jurisdiction,
            workIdentifier: `${number}/${year} Sb.`,
            reference: ref,
          });
          expect(constructed.status).toBe("resolved");
          if (constructed.status !== "resolved") {return;}
          const { provision } = constructed;
          expect(provision.reference).toEqual(ref);
          expect(provision.anchor).toBe(parsed.at(0)?.anchor);
          expect(provision.workEli).toBe(work.eli);
          expect(parseProvisionKey(formatProvisionKey(provision))).toEqual({
            jurisdiction: provision.jurisdiction,
            workIdentifier: work.identifier,
            anchor: provision.anchor,
          });
        },
      ),
    );
  });

  test("every recorded section 64 fragment retains the publisher's AST anchor", async () => {
    const fixtureUrl = new URL(
      "__fixtures__/cz-esbirka-500-2004-par-64.json",
      import.meta.url,
    );
    const bytes = await Bun.file(fixtureUrl).bytes();
    expect(provenance.capture).toBe("recorded");
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(
      provenance.sha256,
    );
    expect(fixture.results.bindings).toHaveLength(13);
    const levels = new Set<string>();
    for (const { citace, url } of fixture.results.bindings) {
      const parsed = grammar.locateAbbreviatedProvisions(
        `${citace.value} s. ř. s.`,
      );
      expect(parsed).toHaveLength(1);
      const ref = parsed.at(0)?.reference;
      expect(ref).toBeDefined();
      if (ref === undefined) {
        continue;
      }
      expect(grammar.anchor(ref)).toBe(url.value.split("#").at(1));
      let level = "section";
      if (ref.subsection !== null) {
        level = "subsection";
      }
      if (ref.letter !== null) {
        level = "letter";
      }
      if (ref.point !== null) {
        level = "point";
      }
      levels.add(level);
    }
    expect(levels).toEqual(
      new Set(["section", "subsection", "letter", "point"]),
    );
  });

  test("gazette spelling normalizes consistently with extracted work ELIs", () => {
    expect(grammar.gazette.parse(" č. 00089/2012 Sb. ")).toEqual({
      identifier: "89/2012 Sb.",
      eli: "https://www.e-sbirka.cz/eli/cz/sb/2012/89",
    });
    expect(grammar.locateGazetteCitations("00089/2012 Sb.").at(0)?.eli).toBe(
      grammar.gazette.parse("00089/2012 Sb.")?.eli,
    );
    for (const raw of [
      "89/2012 Sb. NSS",
      "89/2012 Sb. m. s.",
      "x 89/2012 Sb.",
      "89/2012 Sb. suffix",
      "bad",
    ]) {
      expect(grammar.gazette.parse(raw)).toBeNull();
    }
  });

  test("sentence and open-ended scope preserve the section anchor", () => {
    const ref = {
      unit: "section",
      section: 1,
      sectionSuffix: null,
      subsection: "2",
      letter: "a",
      point: "3",
      sentence: null,
      openEnded: false,
    } as const;
    expect(grammar.anchor(ref)).toBe("par_1-odst_2-pism_a-bod_3");
    expect(grammar.anchor({ ...ref, sentence: "2", openEnded: true })).toBe(
      grammar.anchor(ref),
    );
  });

  test("reference construction normalizes the work and rejects unavailable grammars or identifiers", () => {
    const ref = {
      unit: "section",
      section: 5,
      sectionSuffix: null,
      subsection: "2",
      letter: null,
      point: null,
      sentence: null,
      openEnded: false,
    } as const;
    expect(
      provisionRefOf({
        jurisdiction: "CZE",
        workIdentifier: "č. 00089/2012 Sb.",
        reference: ref,
      }),
    ).toEqual({
      status: "resolved",
      provision: {
        jurisdiction: "CZE",
        workIdentifier: "89/2012 Sb.",
        workEli: "https://www.e-sbirka.cz/eli/cz/sb/2012/89",
        reference: ref,
        anchor: "par_5-odst_2",
      },
    });
    expect(
      provisionRefOf({
        jurisdiction: "CZE",
        workIdentifier: "bad",
        reference: ref,
      }),
    ).toEqual({ status: "invalid_work_identifier" });
    for (const jurisdiction of CASE_LAW_JURISDICTIONS) {
      if (jurisdiction === "CZE") {continue;}
      expect(
        provisionRefOf({
          jurisdiction,
          workIdentifier: "89/2012 Sb.",
          reference: ref,
        }),
      ).toEqual({ status: "unsupported" });
    }
  });

  test("the profile and grammar share the statute collection declaration", () => {
    expect(CZ_PROFILE.collections).toContain(CZ_STATUTE_COLLECTION);
    expect(grammar.gazette.parse("89/2012 Sb.")?.identifier).toBe(
      `89/2012 ${CZ_STATUTE_COLLECTION.canonical}`,
    );
  });

  test("every other jurisdiction explicitly declines provision construction", () => {
    for (const jurisdiction of CASE_LAW_JURISDICTIONS) {
      if (jurisdiction === "CZE") {
        continue;
      }
      expect(PROVISION_CITATION_GRAMMARS[jurisdiction]).toEqual({
        jurisdiction,
        status: "unsupported",
      });
    }
  });
});
