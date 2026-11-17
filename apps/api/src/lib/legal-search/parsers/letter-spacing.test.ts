import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import type { Block } from "@stll/legal-ast/document-ast";
import { plainTextOf } from "@stll/legal-ast/document-ast";
import { assertProperty } from "@stll/property-testing";

import { withAttestedLetterSpacing } from "./letter-spacing";

const czechWord = fc.stringMatching(
  /^[A-Za-zÁČĎÉĚÍŇÓŘŠŤÚŮÝŽáčďéěíňóřšťúůýž]{2,12}$/u,
);

describe("withAttestedLetterSpacing", () => {
  const paragraphOf = (plainText: string): Block => ({
    id: "b1",
    anchorId: "p-1",
    type: "paragraph",
    inlines: [{ type: "text", text: plainText }],
    plainText,
  });

  const witness = paragraphOf("Povinný může podat návrh.");

  test("reads a word spaced unevenly inside a sentence as the word the decision prints intact elsewhere", () => {
    const [spaced] = withAttestedLetterSpacing([
      paragraphOf("Nesplní-li povinný, m ů že oprávněný podat návrh."),
      witness,
    ]);
    expect(spaced?.plainText).toBe(
      "Nesplní-li povinný, může oprávněný podat návrh.",
    );
    expect(spaced?.type === "paragraph" ? spaced.inlines : []).toEqual([
      { type: "text", text: "Nesplní-li povinný, může oprávněný podat návrh." },
    ]);
  });

  test("leaves the same spacing when the decision never prints the word", () => {
    const blocks = [paragraphOf("Nesplní-li povinný, m ů že oprávněný.")];
    expect(withAttestedLetterSpacing(blocks)).toEqual(blocks);
  });

  test("never changes a character that is not whitespace, and is idempotent", () => {
    assertProperty(
      "never changes a character that is not whitespace, and is idempotent",
      fc.property(
        fc.constantFrom("m ů že", "m ůže", "m ů ž e", "mů ž e", "může"),
        fc.array(czechWord, { minLength: 0, maxLength: 4 }),
        fc.array(czechWord, { minLength: 0, maxLength: 4 }),
        (spelled, before, after) => {
          const text = [...before, spelled, ...after].join(" ");
          const blocks = [paragraphOf(text), witness];
          const once = withAttestedLetterSpacing(blocks);
          const [first] = once;
          expect(first?.plainText.replaceAll(/\s/gu, "")).toBe(
            text.replaceAll(/\s/gu, ""),
          );
          for (const block of once) {
            if (block.type === "paragraph") {
              expect(block.plainText).toBe(plainTextOf(block.inlines).trim());
            }
          }
          expect(withAttestedLetterSpacing(once)).toEqual(once);
        },
      ),
    );
  });

  // A spaced word split across formatting nodes cannot be read inside one
  // node; the block's text must then still say what its inlines say.
  test("derives the block's text from its repaired inlines", () => {
    const [mixed] = withAttestedLetterSpacing([
      {
        id: "b2",
        anchorId: "p-2",
        type: "paragraph",
        inlines: [
          { type: "text", text: "m ů že a m " },
          { type: "bold", children: [{ type: "text", text: "ů že" }] },
        ],
        plainText: "m ů že a m ů že",
      },
      witness,
    ]);
    expect(mixed?.type).toBe("paragraph");
    if (mixed?.type !== "paragraph") {
      return;
    }
    expect(mixed.plainText).toBe(plainTextOf(mixed.inlines).trim());
    expect(mixed.plainText).toBe("může a m ů že");
  });
});
