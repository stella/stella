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
