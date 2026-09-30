import { describe, expect, test } from "bun:test";

import { readRtfText } from "./rtf";
import { TEXT_ORACLE_LIMITS } from "./types";

const read = (source: string) => readRtfText(new TextEncoder().encode(source));
const textOf = (source: string) => {
  const result = read(source);
  expect(result.isOk()).toBe(true);
  if (result.isErr()) {
    throw result.error;
  }
  return result.value.text;
};

describe("independent RTF visible text baseline", () => {
  test("formatting segmentation keeps adjacent text and repeated words intact", () => {
    const phrase = "Words recur recur in court documents.";
    for (let split = 0; split <= phrase.length; split += 1) {
      expect(
        textOf(
          `{\\rtf1 ${phrase.slice(0, split)}{\\b ${phrase.slice(split)}}}`,
        ),
      ).toBe(phrase);
    }
  });

  test("unknown visible groups, starred textboxes, notes and object results survive", () => {
    const source =
      "{\\rtf1 BODY{\\mystery UNKNOWN}{\\*\\shptxt TEXTBOX}{\\footnote NOTE}{\\object{\\*\\objdata 0102}{\\result OBJECTRESULT}}{\\field{\\*\\fldinst INSTRUCTION}{\\fldrslt FIELDRESULT}}}";
    expect(textOf(source)).toBe(
      "BODYUNKNOWNTEXTBOXNOTEOBJECTRESULTFIELDRESULT",
    );
  });

  test("metadata and picture bytes never count as visible text", () => {
    expect(
      textOf(
        "{\\rtf1{\\fonttbl{\\f0 Arial;}}{\\info{\\title Metadata}}{\\pict deadbeef}VISIBLE}",
      ),
    ).toBe("VISIBLE");
  });

  test("Unicode fallback and escaped bytes preserve the same visible characters", () => {
    expect(textOf("{\\rtf1\\ansicpg1250 \\'e8\\u269?\\uc2\\u269\\'63?}")).toBe(
      "ččč",
    );
    expect(textOf("{\\rtf1\\uc0\\u-10179\\u-8704}")).toBe("😀");
    expect(textOf("{\\rtf1 \\{quoted\\}\\\\}")).toBe("{quoted}\\");
  });

  test("font charset selects the declared encoding across nested groups", () => {
    const source =
      "{\\rtf1\\ansi\\ansicpg1252\\deff0{\\fonttbl{\\f0\\fcharset0 Western;}{\\f1\\fcharset238 Central;}}\\f1 \\'f5{\\f0 \\'f5}\\'f5}";
    expect(textOf(source)).toBe("őõő");
  });

  test("malformed, unsupported and over-budget inputs yield explicit failures", () => {
    for (const source of [
      "{\\rtf1 unclosed",
      "{\\rtf1\\'xy}",
      "{\\rtf1\\u999999?}",
      "{\\rtf1}trailing",
    ]) {
      const result = read(source);
      expect(result.isErr() && result.error.reason).toBe("malformed");
    }
    for (const source of [
      "{\\rtf1{\\*\\unknown invisible?}}",
      "{\\rtf1\\v HIDDEN}",
      "{\\rtf1\\deleted OLD}",
      "{\\rtf1\\chftn}",
      "{\\rtf1\\upr{ANSI}{\\*\\ud UNICODE}}",
    ]) {
      const result = read(source);
      expect(result.isErr() && result.error.reason).toBe("unsupported");
    }
    const unknownPage = read("{\\rtf1\\ansicpg9999 hello}");
    expect(unknownPage.isErr() && unknownPage.error.reason).toBe("unsupported");
    const deep = read(
      `{\\rtf1 ${"{".repeat(TEXT_ORACLE_LIMITS.depth)}text${"}".repeat(TEXT_ORACLE_LIMITS.depth)}}`,
    );
    expect(deep.isErr() && deep.error.reason).toBe("resource_limit");
    const large = read(
      `{\\rtf1 ${"x".repeat(TEXT_ORACLE_LIMITS.textCharacters + 1)}}`,
    );
    expect(large.isErr() && large.error.reason).toBe("resource_limit");
  });
});
