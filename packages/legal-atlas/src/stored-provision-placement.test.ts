import { expect, test } from "bun:test";
import fc from "fast-check";

import { fulltextProjectionPieces } from "@stll/legal-ast/projection-digest";
import { assertProperty } from "@stll/property-testing";

import {
  placeStoredProvision,
  placeStoredProvisions,
} from "./stored-provision-placement";
import type { StoredProvisionPlacementRow } from "./stored-provision-placement";

const version = {
  id: "wording",
  eli: "https://www.e-sbirka.cz/eli/cz/sb/2002/150",
  expressionKind: "consolidation",
  windowDisposition: "effective",
  versionValidFrom: "2003-01-01",
  versionValidTo: null,
} as const;
const row = {
  id: "row",
  jurisdiction: "CZE",
  workEli: version.eli,
  versionValidFrom: "2025-01-01",
  reference: {
    unit: "section",
    section: 7,
    sectionSuffix: null,
    subsection: null,
    letter: null,
  },
  sentenceText: "Soud použil § 7 s. ř. s.",
  spanStart: 0,
} as const satisfies StoredProvisionPlacementRow;
const text = {
  type: "fulltext",
  text: row.sentenceText,
  decisionDate: "2025-01-01",
} as const;

test("version availability and half-open windows yield explicit outcomes", () => {
  const options = { row, text, versions: [version] };
  expect(placeStoredProvision(options).status).toBe("placed");
  expect(
    placeStoredProvision({ ...options, row: { ...row, workEli: null } }),
  ).toEqual({ status: "unplaced", reason: "work-unresolved" });
  expect(placeStoredProvision({ ...options, versions: [] })).toEqual({
    status: "unplaced",
    reason: "statute-not-loaded",
  });
  expect(
    placeStoredProvision({
      ...options,
      versions: [{ ...version, versionValidTo: row.versionValidFrom }],
    }),
  ).toEqual({ status: "unplaced", reason: "no-version-in-force" });
  expect(
    placeStoredProvision({
      ...options,
      versions: [{ ...version, windowDisposition: "withdrawn" }],
    }),
  ).toEqual({ status: "unplaced", reason: "no-version-in-force" });
  expect(
    placeStoredProvision({
      ...options,
      versions: [version, { ...version, id: "competing" }],
    }),
  ).toEqual({ status: "unplaced", reason: "ambiguous-version" });
  expect(
    placeStoredProvision({
      ...options,
      row: { ...row, versionValidFrom: null },
      text: { ...text, decisionDate: null },
    }),
  ).toEqual({ status: "unplaced", reason: "version-not-stated" });
});

test("Czech coordinated references place in both stored fulltext and section blocks", () => {
  assertProperty(
    "stored provision coordination preserves every occurrence across text forms",
    fc.property(
      fc.integer({ min: 1, max: 9999 }),
      fc.constantFrom(
        "Žalobce",
        "Příslušný soud",
        "Účastník řízení",
        "Český soud",
      ),
      fc.constantFrom(" ", "\u00a0", "\n", "\n\n"),
      (section, prefix, separator) => {
        const sentence = `${prefix} použil §§ ${section} a ${section + 1} s. ř. s.`;
        const rendered = sentence.replace(
          " použil",
          () => `${separator}použil`,
        );
        const rows = [section, section + 1].map((value, index) => ({
          ...row,
          id: `row-${index}`,
          sentenceText: sentence,
          reference: { ...row.reference, section: value },
          spanStart: index,
        }));
        const pieces = fulltextProjectionPieces(rendered);
        const forms = [
          { type: "fulltext", text: rendered, decisionDate: text.decisionDate },
          {
            type: "blocks",
            decisionDate: text.decisionDate,
            blocks: pieces.map(({ pieceId, text: paragraph }) => ({
              type: "paragraph",
              id: pieceId,
              anchorId: pieceId,
              plainText: paragraph,
              inlines: [{ type: "text", text: paragraph }],
            })),
          },
        ] as const;
        for (const form of forms) {
          const outcomes = placeStoredProvisions({
            rows,
            text: form,
            versions: [version],
          });
          expect(outcomes.map(({ id }) => id)).toEqual(
            rows.map(({ id }) => id),
          );
          for (const [index, { placement }] of outcomes.entries()) {
            expect(placement.status).toBe("placed");
            if (placement.status === "placed") {
              const piece = pieces.find(
                ({ pieceId }) => pieceId === placement.pieceId,
              );
              expect(
                piece?.text.slice(placement.start, placement.end),
              ).toContain(String(section + index));
            }
          }
        }
      },
    ),
  );
});

test("every stored row keeps a placement or failure when versions and text are unavailable", () => {
  assertProperty(
    "stored provision outcomes are total under missing context",
    fc.property(fc.boolean(), fc.boolean(), (available, visible) => {
      const rows = [
        { ...row, id: "first" },
        { ...row, id: "second" },
      ];
      const outcomes = placeStoredProvisions({
        rows,
        text: { ...text, text: visible ? text.text : "Jiný obsah." },
        versions: available ? [version] : [],
      });
      expect(outcomes).toHaveLength(rows.length);
      expect(outcomes.map(({ id }) => id)).toEqual(rows.map(({ id }) => id));
      if (available && visible) {
        expect(outcomes.map(({ placement }) => placement.status)).toEqual([
          "placed",
          "unplaced",
        ]);
        expect(outcomes.at(1)?.placement).toEqual({
          status: "unplaced",
          reason: "span-overlap",
        });
      } else {
        expect(
          outcomes.every(({ placement }) => placement.status === "unplaced"),
        ).toBe(true);
      }
    }),
  );
});
