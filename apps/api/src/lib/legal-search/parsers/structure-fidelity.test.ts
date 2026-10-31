import { expect, test } from "bun:test";

import type { Block } from "@stll/legal-ast/document-ast";

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
