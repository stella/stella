import { expect, test } from "bun:test";

import type { Block, ParagraphBlock } from "@stll/legal-ast/document-ast";

import {
  STRUCTURE_FIDELITY_RULES,
  structureFidelityIn,
} from "./structure-fidelity";

const paragraphs = (texts: readonly string[]): Block[] =>
  texts.map((text, index) => ({
    id: `b${String(index)}`,
    anchorId: `p-${String(index)}`,
    type: "paragraph",
    role: "intro",
    inlines: [{ type: "text", text }],
    plainText: text,
  }));

const sentenceCuts = (texts: readonly string[]): string[] =>
  structureFidelityIn(paragraphs(texts))
    .filter(({ rule }) => rule === STRUCTURE_FIDELITY_RULES.SENTENCE_CUT)
    .map(({ anchorId }) => anchorId);

test("a separator word between two labelled party lines is not a cut sentence", () => {
  expect(
    sentenceCuts([
      "žalobce: Jan Novák, bytem Praha, zastoupený advokátem Petrem Dvořákem",
      "proti",
      "žalovaná: Česká republika",
    ]),
  ).toEqual([]);
});

test("a one-word continuation followed by prose is still a cut sentence", () => {
  expect(
    sentenceCuts([
      "Soud prvního stupně rozhodl o věci samé a o nákladech řízení v souladu se",
      "zákonem",
      "Odvolání je přípustné do patnácti dnů.",
    ]),
  ).toEqual(["p-0"]);
});

test("a separator word not followed by a labelled line is still a cut sentence", () => {
  expect(
    sentenceCuts([
      "žalobce: Jan Novák, bytem Praha, zastoupený advokátem Petrem Dvořákem",
      "proti",
      "České republice o zaplacení částky.",
    ]),
  ).toEqual(["p-0"]);
});

test.each([
  [
    "Höhenexponent max. 2-Sek.-Mittel der Windgeschwindigkeit0,1429 nach Messung",
    "50-jährliches, max. 2-Sek.-Mittel der Windg. in 100 m Höhe 43,9 m/s",
  ],
  [
    "50-jährliches, max. 5-Sek.-Mittel der Windg. in 100 m Höhe 42,6 m/s",
    "1-jährliches, max. 10-Min.-Mittel der Windg. in 10 m Höhe 16,9 m/s",
  ],
])("a printed table row is not a cut sentence: %s", (row, next) => {
  expect(sentenceCuts([row, next])).toEqual([]);
});

test("a prose line with one number is still a cut sentence", () => {
  expect(
    sentenceCuts([
      "Der Bescheid wurde der Beschwerdeführerin im Jahr 2020 zugestellt und die Frist",
      "begann mit dem Tag der Zustellung zu laufen.",
    ]),
  ).toEqual(["p-0"]);
});

test("a digit-led prose continuation after a long line is still a cut sentence", () => {
  expect(
    sentenceCuts([
      "Diese Bestimmungen sind im Wesentlichen textgleich mit § 75 Abs. 1 der GewO",
      "1994, mit weiteren Nachweisen zur ständigen Rechtsprechung.",
    ]),
  ).toEqual(["p-0"]);
});

const paragraph = (anchorId: string, plainText: string): ParagraphBlock => ({
  id: anchorId,
  anchorId,
  type: "paragraph",
  role: "intro",
  inlines: [{ type: "text", text: plainText }],
  plainText,
});

test("a sentence split between paragraph blocks is reported at its first half", () => {
  const findings = structureFidelityIn([
    paragraph(
      "p-1",
      "Sąd Apelacyjny w Szczecinie rozpoznał sprawę na posiedzeniu niejawnym,",
    ),
    paragraph("p-2", "sprawy z odwołania strony."),
  ]);

  expect(findings).toHaveLength(1);
  expect(findings[0]).toMatchObject({
    rule: "sentence-cut",
    anchorId: "p-1",
  });
  expect(findings[0]?.excerpt).toContain("⏎ sprawy z odwołania strony.");
});

test("a sentence kept in one paragraph has no sentence-cut finding", () => {
  const findings = structureFidelityIn([
    paragraph(
      "p-1",
      "Sąd rozpoznał sprawę na posiedzeniu niejawnym, sprawy z odwołania strony.",
    ),
  ]);

  expect(findings).toEqual([]);
});

type RoledBlock = readonly [ParagraphBlock["role"] | "heading", string];

const roled = (blocks: readonly RoledBlock[]): Block[] =>
  blocks.map(([role, text], index) =>
    role === "heading"
      ? {
          id: `b${String(index)}`,
          anchorId: `h-${String(index)}`,
          type: "heading",
          level: 2,
          role: "section-heading",
          inlines: [{ type: "text", text }],
          plainText: text,
        }
      : {
          id: `b${String(index)}`,
          anchorId: `p-${String(index)}`,
          type: "paragraph",
          ...(role === undefined ? {} : { role }),
          inlines: [{ type: "text", text }],
          plainText: text,
        },
  );

const roleFindings = (
  blocks: readonly RoledBlock[],
  language: string | undefined,
): string[] =>
  structureFidelityIn(roled(blocks), language)
    .filter(
      ({ rule }) =>
        rule === STRUCTURE_FIDELITY_RULES.SIGNATURE_AS_HOLDING ||
        rule === STRUCTURE_FIDELITY_RULES.HOLDING_AFTER_REASONS,
    )
    .map(({ rule, anchorId }) => `${rule} ${anchorId}`);

test("a bench signing under its ruling is not the ruling", () => {
  expect(
    roleFindings(
      [
        ["holding", "1. zasądza od pozwanego na rzecz powoda kwotę 100 zł;"],
        ["holding", "SSO Katarzyna Banko"],
        ["holding", "Przewodniczący:…………………………"],
      ],
      "pl",
    ),
  ).toEqual(["signature-as-holding p-1", "signature-as-holding p-2"]);
  expect(
    roleFindings(
      [
        ["holding", "I. Kasační stížnost se zamítá."],
        ["holding", "předseda rozšířeného senátu"],
      ],
      "cs",
    ),
  ).toEqual(["signature-as-holding p-1"]);
});

test("nothing after the reasons heading is the ruling, however it is spaced", () => {
  expect(
    roleFindings(
      [
        ["holding", "1. Uwzględnia odwołanie."],
        ["holding", "U z a s a d n i e n i e"],
        ["holding", "Zamawiający prowadzi postępowanie."],
        ["argumentation", "Izba zważyła, co następuje."],
      ],
      "pl",
    ),
  ).toEqual(["holding-after-reasons p-2"]);
  expect(
    roleFindings(
      [
        ["holding", "I. Kasační stížnost se zamítá."],
        ["heading", "Odůvodnění:"],
        ["holding", "Žalobce podal žalobu."],
      ],
      "cs",
    ),
  ).toEqual(["holding-after-reasons p-2"]);
});

test("a language without a role grammar is read for printed-page shapes only", () => {
  expect(
    roleFindings(
      [
        ["holding", "SSO Katarzyna Banko"],
        ["heading", "Uzasadnienie"],
        ["holding", "Zamawiający prowadzi postępowanie."],
      ],
      undefined,
    ),
  ).toEqual([]);
  expect(
    roleFindings(
      [
        ["holding", "1. zasądza od pozwanego kwotę 100 zł;"],
        ["holding", "2. oddala powództwo w pozostałym zakresie."],
        ["signature", "SSO Katarzyna Banko"],
        ["heading", "Uzasadnienie"],
        ["argumentation", "Powód domagał się zasądzenia."],
      ],
      "pl",
    ),
  ).toEqual([]);
});
