import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import { encodeHTML } from "entities";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import {
  decodeSourceRawEnvelope,
  STORED_RAW_REPARSE_REJECTION,
} from "@/api/handlers/case-law/ingestion/adapter";
import {
  assembleSkCourtsDecision,
  skCourtsListingIdentity,
  skCourtsAdapter,
} from "@/api/handlers/case-law/ingestion/adapters/sk-courts";
import { entityResidueIn } from "@/api/lib/legal-search/parsers/entity-residue";

const fixture = () =>
  ({
    item: {
      guid: "source&amp;key",
      spisovaZnacka: "7C&#x2F;221/1991",
      sud: {
        registreGuid: "sud_102",
        nazov: "Okresn&#253; s&#250;d Bratislava I",
      },
      sudca: { meno: "JUDr. M&#225;rie &#x160;imekovej" },
      formaRozhodnutia: "Uznesenie&nbsp;o trov&#225;ch",
      povaha: ["Ob&#269;ianskopr&#225;vne", "A &amp; B"],
    },
    detail: {
      oblast: ["Ob&#269;ianske pr&#225;vo"],
      podOblast: ["N&#225;hrada &#x161;kody"],
      odkazovanePredpisy: [
        {
          nazov: "Z&#225;kon &amp; predpis",
          url: "https://example.org/?a=1&amp;b=2",
        },
      ],
      dokument: { name: "Rozsudok_&#381;ilina.pdf" },
      povodnySud: { nazov: "Okresn&#253; s&#250;d &#381;ilina" },
      povodnaSpisovaZnacka: "1C&#47;2/2024",
    },
    courtRegistry: {
      status: "available",
      record: {
        registreGuid: "sud_102",
        nazov: "Okresn&#253; s&#250;d Bratislava I",
        typSudu: "Okresn&#253; s&#250;d",
        skratka_string: "OS&nbsp;BA I",
      },
    },
  }) satisfies Parameters<typeof assembleSkCourtsDecision>[0];

const decisionFor = (judge: string) =>
  assembleSkCourtsDecision({
    item: {
      guid: "fixture",
      spisovaZnacka: "1C/2/2024",
      sud: { nazov: "Okresný súd Žilina" },
      sudca: { meno: judge },
    },
    detail: null,
  }) ?? panic("entity fixture is unkeyable");

// Judicial Unicode text, without literal entity syntax or HTML-invalid scalars.
const judicialText = fc
  .array(
    fc
      .integer({ min: 0x20, max: 0x10_ff_ff })
      .filter(
        (codePoint) =>
          codePoint !== 0x26 &&
          !(codePoint >= 0x7f && codePoint < 0xa0) &&
          !(codePoint >= 0xd8_00 && codePoint <= 0xdf_ff),
      ),
    { maxLength: 100 },
  )
  .map((codePoints) => String.fromCodePoint(...codePoints));

describe("Slovak court display text decodes publisher entities once", () => {
  test("decodes named, decimal and hexadecimal references across display fields", () => {
    const parts = fixture();
    const decision =
      assembleSkCourtsDecision(parts) ?? panic("fixture is unkeyable");
    expect(decision).toMatchObject({
      caseNumber: "7C/221/1991",
      court: "Okresný súd Bratislava I",
      decisionType: "Uznesenie\u00a0o trovách",
      sourceDocumentId: "source&amp;key",
      metadata: {
        judge: "JUDr. Márie Šimekovej",
        decisionNature: ["Občianskoprávne", "A & B"],
        area: ["Občianske právo"],
        subArea: ["Náhrada škody"],
        documentName: "Rozsudok_Žilina.pdf",
        originCourt: "Okresný súd Žilina",
        originCaseNumber: "1C/2/2024",
        referencedLegislation: [
          { nazov: "Zákon & predpis", url: "https://example.org/?a=1&amp;b=2" },
        ],
        courtRegistry: {
          nazov: "Okresný súd Bratislava I",
          typSudu: "Okresný súd",
          skratka_string: "OS\u00a0BA I",
        },
      },
    });
    expect(skCourtsListingIdentity(parts.item)).toEqual({
      type: "document",
      sourceDocumentId: decision.sourceDocumentId,
    });
    expect(skCourtsListingIdentity({ ...parts.item, guid: null })).toEqual({
      type: "case-number",
      caseNumber: decision.caseNumber,
      language: "sk",
    });
    const raw = decodeSourceRawEnvelope(decision.sourceRaw ?? "");
    expect(raw?.["listing"]).toBe(JSON.stringify(parts.item));
    expect(raw?.["detail"]).toBe(JSON.stringify(parts.detail));
    expect(raw?.["court-registry"]).toBe(
      JSON.stringify(parts.courtRegistry.record),
    );
  });

  test("stored raw replay preserves the same single-pass decoded fields", () => {
    const original =
      assembleSkCourtsDecision(fixture()) ?? panic("fixture is unkeyable");
    const replay =
      skCourtsAdapter.reparseStoredRaw ?? panic("adapter has no replay reader");
    const input = {
      raw: new TextEncoder().encode(
        original.sourceRaw ?? panic("fixture stores no raw"),
      ),
      contentType: original.sourceRawContentType ?? "",
      caseNumber: original.caseNumber,
      sourceDocumentId: original.sourceDocumentId ?? null,
      language: "sk",
      court: original.court,
      ecli: null,
      decisionDate: null,
      decisionType: null,
      sourceUrl: null,
      documentUrl: null,
      metadata: {},
    };
    const first = replay(input);
    const second = replay(input);
    expect(first).toMatchObject({ type: "parsed", result: original });
    expect(second).toEqual(first);
  });

  describe("a row stored before decoding replays under its encoded docket", () => {
    const replay =
      skCourtsAdapter.reparseStoredRaw ?? panic("adapter has no replay reader");
    const storedRowFor = ({
      listedDocket,
      storedDocket,
      guid = "sk-guid-1",
    }: {
      listedDocket: string;
      storedDocket: string;
      guid?: string | null;
    }) => {
      const parts = fixture();
      const assembled =
        assembleSkCourtsDecision({
          ...parts,
          item: { ...parts.item, guid, spisovaZnacka: listedDocket },
        }) ?? panic("fixture is unkeyable");
      return {
        raw: new TextEncoder().encode(
          assembled.sourceRaw ?? panic("fixture stores no raw"),
        ),
        contentType: assembled.sourceRawContentType ?? "",
        caseNumber: storedDocket,
        sourceDocumentId: assembled.sourceDocumentId ?? null,
        language: "sk",
        court: assembled.court,
        ecli: null,
        decisionDate: null,
        decisionType: null,
        sourceUrl: null,
        documentUrl: null,
        metadata: {},
      };
    };

    test("the encoded docket a pre-decoding parser stored is the decoded one", () => {
      const outcome = replay(
        storedRowFor({
          listedDocket: "7C&#x2F;221/1991",
          storedDocket: "7C&#x2F;221/1991",
        }),
      );
      expect(outcome).toMatchObject({
        type: "parsed",
        result: { caseNumber: "7C/221/1991", sourceDocumentId: "sk-guid-1" },
        legacyCaseNumber: "7C&#x2F;221/1991",
      });
    });

    test("a docket stored as decoded needs no legacy match", () => {
      const outcome = replay(
        storedRowFor({
          listedDocket: "7C&#x2F;221/1991",
          storedDocket: "7C/221/1991",
        }),
      );
      expect(outcome.type).toBe("parsed");
      expect(outcome).not.toHaveProperty("legacyCaseNumber");
    });

    test("a genuinely different docket is still another decision", () => {
      for (const storedDocket of [
        "7C&#x2F;222/1991",
        "7C/222/1991",
        "7C&#x2f;221/1991 ",
        "7c/221/1991",
      ]) {
        expect(
          replay(
            storedRowFor({ listedDocket: "7C&#x2F;221/1991", storedDocket }),
          ),
        ).toMatchObject({
          type: "rejected",
          rejection: STORED_RAW_REPARSE_REJECTION.IDENTITY_MISMATCH,
        });
      }
    });

    test("a double-encoded docket decodes once on both sides, never twice", () => {
      // The listing itself is double-encoded: ingestion decodes it once, and
      // the legacy row, stored verbatim, decodes once to the same value.
      expect(
        replay(
          storedRowFor({
            listedDocket: "7C&amp;#x2F;221/1991",
            storedDocket: "7C&amp;#x2F;221/1991",
          }),
        ),
      ).toMatchObject({
        type: "parsed",
        result: { caseNumber: "7C&#x2F;221/1991" },
        legacyCaseNumber: "7C&amp;#x2F;221/1991",
      });
      // A stored value that reaches the replayed docket only on a second
      // decode is not the same docket.
      expect(
        replay(
          storedRowFor({
            listedDocket: "7C&#x2F;221/1991",
            storedDocket: "7C&amp;#x2F;221/1991",
          }),
        ),
      ).toMatchObject({
        type: "rejected",
        rejection: STORED_RAW_REPARSE_REJECTION.IDENTITY_MISMATCH,
      });
    });

    test("a row keyed by its docket is not migrated to a new spelling", () => {
      expect(
        replay(
          storedRowFor({
            listedDocket: "7C&#x2F;221/1991",
            storedDocket: "7C&#x2F;221/1991",
            guid: null,
          }),
        ),
      ).toMatchObject({
        type: "rejected",
        rejection: STORED_RAW_REPARSE_REJECTION.IDENTITY_MISMATCH,
      });
    });
  });

  test("preserves literal ampersands, unknown entities, and unfinished references", () => {
    const text = "Novák & synovia; &neexistuje; &#x; &#; &amp bez bodkočiarky";
    expect(decisionFor(text).metadata?.["judge"]).toBe(text);
    expect(decisionFor(encodeHTML(text)).metadata?.["judge"]).toBe(text);
  });

  test("double encoding decodes exactly once even when output resembles an entity", () => {
    for (const { source, expected } of [
      { source: "&amp;amp;", expected: "&amp;" },
      { source: "&amp;#253;", expected: "&#253;" },
      { source: "&amp;#xFD;", expected: "&#xFD;" },
      { source: "&amp;nbsp;", expected: "&nbsp;" },
    ]) {
      expect(decisionFor(source).metadata?.["judge"]).toBe(expected);
    }
  });

  test("absent text remains absent", () => {
    const decision = assembleSkCourtsDecision({
      item: {
        spisovaZnacka: "1C/2/2024",
        sud: { nazov: "Okresný súd Žilina" },
        povaha: null,
      },
      detail: { oblast: null, podOblast: null, odkazovanePredpisy: null },
    });
    expect(decision?.metadata).toMatchObject({
      judge: undefined,
      area: null,
      subArea: null,
      decisionNature: null,
      referencedLegislation: null,
    });
    expect(assembleSkCourtsDecision({ item: {}, detail: null })).toBeNull();
  });

  test("Slovak court entity round trips preserve Unicode without residue", () => {
    assertProperty(
      "Slovak court entity round trips preserve Unicode without residue",
      fc.property(judicialText, (text) => {
        const encodings = [
          encodeHTML(text),
          [...text]
            .map((character) => `&#${character.codePointAt(0)};`)
            .join(""),
          [...text]
            .map((character) => `&#x${character.codePointAt(0)?.toString(16)};`)
            .join(""),
        ];
        for (const encoded of encodings) {
          const decoded = decisionFor(encoded).metadata?.["judge"];
          expect(decoded).toBe(text);
          expect(
            entityResidueIn(typeof decoded === "string" ? decoded : ""),
          ).toBeUndefined();
        }
      }),
    );
  });
});
