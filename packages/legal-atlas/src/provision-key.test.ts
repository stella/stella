import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { CASE_LAW_JURISDICTIONS } from "@stll/api-contract/case-law-jurisdictions";
import { formatProvisionKey } from "@stll/api-contract/provision-key";
import { assertProperty } from "@stll/property-testing";
import { sha256Hex as hashSha256Hex } from "@stll/sha256/node";

import suffixFixture from "./__fixtures__/cz-esbirka-262-2006-par-1a.json" with { type: "json" };
import suffixProvenance from "./__fixtures__/cz-esbirka-262-2006-par-1a.json.provenance.json" with { type: "json" };
import fixture from "./__fixtures__/cz-esbirka-500-2004-par-64.json" with { type: "json" };
import provenance from "./__fixtures__/cz-esbirka-500-2004-par-64.json.provenance.json" with { type: "json" };
import {
  CZ_PROFILE,
  CZ_STATUTE_COLLECTION,
} from "./cz-provision-citation-profile";
import { PROVISION_CITATION_GRAMMARS } from "./provision-citation-grammars";
import { formatWorkIdentifier } from "./provision-citation-profile";
import { provisionRefOf, parseProvisionKey } from "./provision-key";

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
          expect(grammar.parseReference(printed)).toEqual(ref);
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
          if (constructed.status !== "resolved") {
            return;
          }
          const { provision } = constructed;
          expect(provision.reference).toEqual(ref);
          expect(provision.workEli).toBe(work.eli);
          const decoded = parseProvisionKey(formatProvisionKey(provision));
          expect(decoded).not.toBeNull();
          if (decoded === null) {
            return;
          }
          expect(decoded.jurisdiction).toBe(provision.jurisdiction);
          expect(decoded.workIdentifier).toBe(work.identifier);
          expect(decoded.anchor).toBe(provision.anchor);
        },
      ),
    );
  });

  const captures = [
    {
      file: "cz-esbirka-500-2004-par-64.json",
      fixture,
      provenance,
      workIdentifier: "500/2004 Sb.",
      rows: 13,
    },
    {
      file: "cz-esbirka-262-2006-par-1a.json",
      fixture: suffixFixture,
      provenance: suffixProvenance,
      workIdentifier: "262/2006 Sb.",
      rows: 8,
    },
  ];

  test.each(captures)(
    "recorded fragments of $workIdentifier retain their publisher anchors",
    async (capture) => {
      const bytes = await Bun.file(
        new URL(`__fixtures__/${capture.file}`, import.meta.url),
      ).bytes();
      expect(hashSha256Hex(bytes)).toBe(capture.provenance.sha256);
      expect(capture.provenance.capture).toBe("recorded");
      expect(capture.fixture.results.bindings).toHaveLength(capture.rows);
      for (const { citace, url } of capture.fixture.results.bindings) {
        const ref = grammar.parseReference(citace.value);
        expect(ref).not.toBeNull();
        if (ref === null) {
          continue;
        }
        const constructed = provisionRefOf({
          jurisdiction: "CZE",
          workIdentifier: capture.workIdentifier,
          reference: ref,
        });
        expect(constructed.status).toBe("resolved");
        if (constructed.status !== "resolved") {
          continue;
        }
        expect(constructed.provision.workIdentifier).toBe(
          capture.workIdentifier,
        );
        const recordedPath = new URL(
          url.value,
          "https://www.e-sbirka.cz",
        ).pathname.split("/");
        const collection = recordedPath.at(1);
        const year = recordedPath.at(2);
        const number = recordedPath.at(3);
        if (collection !== "sb" || year === undefined || number === undefined) {
          panic("Malformed recorded publisher URL");
        }
        expect(collection).toBe("sb");
        expect(year).toMatch(/^\d{4}$/u);
        expect(number).toMatch(/^\d+$/u);
        expect(constructed.provision.workEli).toBe(
          `https://www.e-sbirka.cz/eli/cz/${collection}/${year}/${number}`,
        );
        expect(constructed.provision.anchor).toBe(
          new URL(url.value, "https://www.e-sbirka.cz").hash.slice(1),
        );
        expect(grammar.parseAnchor(constructed.provision.anchor)).toEqual(ref);
      }
    },
  );

  const recorded = captures.flatMap((capture) =>
    capture.fixture.results.bindings.map((row) => ({
      ...row,
      workIdentifier: capture.workIdentifier,
    })),
  );
  test("recorded anchors remain invariant under numeric padding and Unicode typography", () => {
    assertProperty(
      "recorded anchors remain invariant under numeric padding and Unicode typography",
      fc.property(
        fc.constantFrom(...recorded),
        fc.integer({ min: 0, max: 2 }),
        fc.constantFrom(" ", "\u00a0", "\u202f"),
        (row, padding, space) => {
          const heading = row.citace.value
            .replace(/\d+/gu, (digits) =>
              digits.padStart(digits.length + padding, "0"),
            )
            .replaceAll(" ", () => space)
            .normalize("NFD");
          const ref = grammar.parseReference(heading);
          expect(ref).not.toBeNull();
          if (ref === null) {
            return;
          }
          const constructed = provisionRefOf({
            jurisdiction: "CZE",
            workIdentifier: row.workIdentifier,
            reference: ref,
          });
          expect(constructed.status).toBe("resolved");
          if (constructed.status !== "resolved") {
            return;
          }
          expect(constructed.provision.anchor).toBe(
            new URL(row.url.value, "https://www.e-sbirka.cz").hash.slice(1),
          );
        },
      ),
    );
  });

  const weightedAnchors = fc
    .array(
      fc.oneof(
        {
          weight: 6,
          arbitrary: fc.constantFrom('"', "\\", ",", "]", "e\u0301", "r\u030c"),
        },
        {
          weight: 1,
          arbitrary: fc.constantFrom("a", "1", "_", "-", "🙂", "中"),
        },
      ),
      { minLength: 1, maxLength: 40 },
    )
    .map((parts) => parts.join(""));
  test("non-provision anchors cannot become branded keys", () => {
    assertProperty(
      "non-provision anchors cannot become branded keys",
      fc.property(weightedAnchors, (anchor) => {
        expect(
          parseProvisionKey(JSON.stringify(["CZE", "89/2012 Sb.", anchor])),
        ).toBeNull();
      }),
    );
  });

  test("controls and lone surrogates cannot enter provision keys", () => {
    assertProperty(
      "controls and lone surrogates cannot enter provision keys",
      fc.property(
        fc.oneof(
          fc.integer({ min: 0, max: 31 }),
          fc.integer({ min: 127, max: 159 }),
          fc.integer({ min: 0xd8_00, max: 0xdf_ff }),
        ),
        (code) => {
          expect(
            parseProvisionKey(
              JSON.stringify([
                "CZE",
                "89/2012 Sb.",
                `par_5${String.fromCodePoint(code)}`,
              ]),
            ),
          ).toBeNull();
        },
      ),
    );
  });

  test.each([
    "par_05",
    "par_5-odst_01",
    "par_5-pism_a)",
    "par_5-pism_A",
    "par_5-bod_2-odst_1",
    "par_0",
    "par_5-odst_",
    "]",
    "par_5e\u0301",
    "par_5é",
  ])("rejects noncanonical publisher anchor %s", (anchor) => {
    expect(
      parseProvisionKey(JSON.stringify(["CZE", "89/2012 Sb.", anchor])),
    ).toBeNull();
  });

  test.each([
    "not json",
    "null",
    "{}",
    '["CZE","89/2012 Sb."]',
    '["CZE","89/2012 Sb.","par_5","2026-01-01"]',
    '["XXX","89/2012 Sb.","par_5"]',
    '["SVK","89/2012 Sb.","par_5"]',
    '["CZE","","par_5"]',
    '["CZE","89/2012 Sb.",""]',
    '["CZE",89,"par_5"]',
    '[ "CZE", "89/2012 Sb.", "par_5" ]',
    '["CZE","00089/2012 Sb.","par_5"]',
    '["CZE","89/2012 Sb","par_5"]',
    '["CZE","89/2012 Sb.","par_5\\u0000"]',
    '["CZE","89/2012 Sb.","par_5\\ud800"]',
    '["CZE","89/2012 Sb.","par_5\\u000a"]',
  ])("rejects invalid or noncanonical keys %s", (raw) => {
    expect(parseProvisionKey(raw)).toBeNull();
  });

  test("reference scope changes leave the branded key unchanged", () => {
    const ref = grammar.parseReference("§ 5 odst. 2");
    expect(ref).not.toBeNull();
    if (ref === null) {
      return;
    }
    const original = provisionRefOf({
      jurisdiction: "CZE",
      workIdentifier: "89/2012 Sb.",
      reference: ref,
    });
    const scoped = provisionRefOf({
      jurisdiction: "CZE",
      workIdentifier: "89/2012 Sb.",
      reference: { ...ref, sentence: "3", openEnded: true },
    });
    expect(original.status).toBe("resolved");
    expect(scoped.status).toBe("resolved");
    if (original.status !== "resolved" || scoped.status !== "resolved") {
      return;
    }
    expect(formatProvisionKey(original.provision)).toBe(
      formatProvisionKey(scoped.provision),
    );
  });

  test("construction rejects invalid reference paths before minting a brand", () => {
    const ref = grammar.parseReference("§ 5 odst. 2");
    expect(ref).not.toBeNull();
    if (ref === null) {
      return;
    }
    for (const invalid of [
      { ...ref, unit: "article" as const },
      { ...ref, section: -1 },
      { ...ref, letter: "two" },
      { ...ref, subsection: "\0" },
    ]) {
      expect(
        provisionRefOf({
          jurisdiction: "CZE",
          workIdentifier: "89/2012 Sb.",
          reference: invalid,
        }),
      ).toEqual({ status: "invalid_reference" });
    }
  });

  test("non-ASCII case-fold lookalikes cannot become provision designators", () => {
    const fields = ["sectionSuffix", "subsection", "letter"] as const;
    assertProperty(
      "non-ASCII case-fold lookalikes cannot become provision designators",
      fc.property(
        fc.constantFrom("ſ", "\u212a", "ı"),
        fc.constantFrom(...fields),
        (lookalike, field) => {
          const ref = grammar.parseReference("§ 5 odst. 2 písm. a)");
          expect(ref).not.toBeNull();
          if (ref === null) {
            return;
          }
          const value = field === "subsection" ? `2${lookalike}` : lookalike;
          expect(
            provisionRefOf({
              jurisdiction: "CZE",
              workIdentifier: "89/2012 Sb.",
              reference: { ...ref, [field]: value },
            }).status,
          ).toBe("invalid_reference");
          const examples = {
            sectionSuffix: {
              anchor: `par_5${lookalike}`,
              printed: `§ 5${lookalike}`,
            },
            subsection: {
              anchor: `par_5-odst_2${lookalike}`,
              printed: `§ 5 odst. 2${lookalike}`,
            },
            letter: {
              anchor: `par_5-pism_${lookalike}`,
              printed: `§ 5 písm. ${lookalike})`,
            },
          } as const satisfies Record<
            (typeof fields)[number],
            { anchor: string; printed: string }
          >;
          const example = examples[field];
          expect(
            parseProvisionKey(
              JSON.stringify(["CZE", "89/2012 Sb.", example.anchor]),
            ),
          ).toBeNull();
          expect(grammar.parseReference(example.printed)).toBeNull();
        },
      ),
    );
  });

  test("ASCII designator case normalizes through the grammar", () => {
    const ref = grammar.parseReference("§ 5A odst. 2B písm. K)");
    expect(ref).not.toBeNull();
    if (ref === null) {
      return;
    }
    expect(ref.sectionSuffix).toBe("a");
    expect(ref.subsection).toBe("2b");
    expect(ref.letter).toBe("k");
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
    const normalized = provisionRefOf({
      jurisdiction: "CZE",
      workIdentifier: "č. 00089/2012 Sb.",
      reference: ref,
    });
    expect(normalized.status).toBe("resolved");
    if (normalized.status !== "resolved") {
      return;
    }
    expect(normalized.provision.jurisdiction).toBe("CZE");
    expect(normalized.provision.workIdentifier).toBe("89/2012 Sb.");
    expect(normalized.provision.workEli).toBe(
      "https://www.e-sbirka.cz/eli/cz/sb/2012/89",
    );
    expect(normalized.provision.reference).toEqual(ref);
    expect(normalized.provision.anchor).toBe("par_5-odst_2");
    expect(
      provisionRefOf({
        jurisdiction: "CZE",
        workIdentifier: "bad",
        reference: ref,
      }),
    ).toEqual({ status: "invalid_work_identifier" });
    for (const jurisdiction of CASE_LAW_JURISDICTIONS) {
      if (jurisdiction === "CZE") {
        continue;
      }
      expect(
        provisionRefOf({
          jurisdiction,
          workIdentifier: "89/2012 Sb.",
          reference: ref,
        }),
      ).toEqual({ status: "unsupported" });
    }
  });

  test("generated gazette identifiers equal the canonical work formatter", () => {
    assertProperty(
      "generated gazette identifiers equal the canonical work formatter",
      fc.property(
        fc.integer({ min: 1, max: 99_999 }),
        fc.integer({ min: 1918, max: 2100 }),
        (number, year) => {
          const identifier = formatWorkIdentifier({
            number,
            year,
            collection: CZ_STATUTE_COLLECTION.canonical,
          });
          expect(grammar.gazette.parse(identifier)?.identifier).toBe(
            identifier,
          );
          expect(
            grammar.gazette.parse(
              `${String(number).padStart(5, "0")}/${year} Sb.`,
            )?.identifier,
          ).toBe(identifier);
        },
      ),
    );
  });

  test.each(CZ_STATUTE_COLLECTION.spellings)(
    "normalizes the declared collection spelling %s",
    (spelling) => {
      expect(grammar.gazette.parse(`89/2012 ${spelling}`)?.identifier).toBe(
        "89/2012 Sb.",
      );
    },
  );

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
