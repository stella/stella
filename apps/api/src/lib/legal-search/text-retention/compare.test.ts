import { describe, expect, test } from "bun:test";

import { compareRetention, normalizeRetentionText } from "./compare";
import { TEXT_ORACLE_LIMITS } from "./types";

describe("source text occurrence retention", () => {
  test.each([
    "αβγ Дело العربية 日本語 42!",
    "repeat repeat",
    "aé e\u0301",
    "(1) 123 — §2",
    "中文判决",
  ])("preserves every unit and bounds the ratio for %s", (source) => {
    const result = compareRetention({
      source,
      output: `${source}\nAdded heading`,
    }).unwrap();
    expect(result).toMatchObject({
      status: "assessed",
      defect: null,
      retainedRatio: 1,
      missingSampleHash: null,
    });
  });

  test("added text cannot compensate for a lost repeated occurrence", () => {
    const result = compareRetention({
      source: "same same 123",
      output: "same 123 added added added",
    }).unwrap();
    expect(result).toMatchObject({
      status: "assessed",
      defect: "text_loss_suspected",
      missingWords: 1,
    });
    if (result.status !== "assessed") {
      return;
    }
    expect(result.retainedRatio).toBeLessThan(1);
    expect(result.missingSampleHash).toMatch(/^[a-f0-9]{64}$/u);
  });

  test("a matching character inventory cannot hide a missing word", () => {
    expect(
      compareRetention({
        source: "legal words",
        output: "gelal drows",
      }).unwrap(),
    ).toMatchObject({ defect: "text_loss_suspected", missingCharacters: 0 });
  });

  test("digits and punctuation are assessed without a language stop list", () => {
    expect(
      compareRetention({ source: "§ 123 Jménem", output: "Jménem" }).unwrap(),
    ).toMatchObject({ defect: "text_loss_suspected", missingWords: 2 });
  });

  test("typographic normalization is idempotent and compatible", () => {
    const source = "oﬃce\u00a0déci\u00adsion e\u0301";
    expect(source).not.toBe("office décision é");
    expect(normalizeRetentionText(source)).toBe("office décision é");
    expect(normalizeRetentionText(normalizeRetentionText(source))).toBe(
      normalizeRetentionText(source),
    );
    expect(
      compareRetention({ source, output: "office décision é" }).unwrap(),
    ).toMatchObject({ defect: null });
  });

  test("empty sources and exhausted limits are explicit outcomes", () => {
    expect(
      compareRetention({ source: " \n", output: "heading" }).unwrap(),
    ).toMatchObject({ status: "empty_source" });
    expect(
      compareRetention({
        source: "x".repeat(TEXT_ORACLE_LIMITS.textCharacters + 1),
        output: "",
      }).unwrapErr().reason,
    ).toBe("resource_limit");
  });
});
