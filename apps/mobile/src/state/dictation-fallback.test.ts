import { describe, expect, test } from "bun:test";

import type { DesktopDictationModels } from "@stll/api-contract/desktop-dictation-transcription";

import { classOf, sameClassFallback } from "./dictation-fallback";

const offered = (
  models: DesktopDictationModels["models"],
  defaultModelId: string | null = null,
): DesktopDictationModels => ({ models, defaultModelId, unavailable: null });

const model = (
  id: string,
  extra: Partial<DesktopDictationModels["models"][number]> = {},
) => ({ id, displayName: id, provider: "Provider A", ...extra });

describe("same-class fallback", () => {
  test("goes only to the same provider, region side and retention", () => {
    const list = offered([
      model("picked"),
      model("other-provider", { provider: "Provider B" }),
      model("outside", { outsideRegion: true }),
      model("retaining", { retainsData: true }),
      model("sibling"),
    ]);
    expect(sameClassFallback("picked", null, list)).toBe("sibling");
  });

  test("never from a model that keeps nothing to one whose provider keeps the audio", () => {
    const list = offered([
      model("picked"),
      model("retaining", { retainsData: true }),
    ]);
    expect(sameClassFallback("picked", null, list)).toBeUndefined();
  });

  test("a model outside the region falls back only to another outside it", () => {
    const list = offered([
      model("picked", { outsideRegion: true }),
      model("inside"),
      model("also-outside", { outsideRegion: true }),
    ]);
    expect(sameClassFallback("picked", null, list)).toBe("also-outside");
  });

  test("the server's default comes first when it qualifies", () => {
    const list = offered(
      [model("picked"), model("first"), model("default")],
      "default",
    );
    expect(sameClassFallback("picked", null, list)).toBe("default");
    const otherDefault = offered(
      [model("picked"), model("first"), model("default", { provider: "B" })],
      "default",
    );
    expect(sameClassFallback("picked", null, otherDefault)).toBe("first");
  });

  test("an unlisted model, or one with no named provider, goes nowhere else", () => {
    expect(
      sameClassFallback("gone", null, offered([model("sibling")], "sibling")),
    ).toBeUndefined();
    const unnamed = offered([
      { id: "picked", displayName: "picked" },
      { id: "sibling", displayName: "sibling" },
    ]);
    expect(sameClassFallback("picked", null, unnamed)).toBeUndefined();
  });

  test("a withdrawn model falls back by the class kept when it was picked", () => {
    const kept = {
      provider: "Provider A",
      outsideRegion: false,
      retainsData: false,
    };
    const list = offered([
      model("other", { provider: "Provider B" }),
      model("keeps", { retainsData: true }),
      model("sibling"),
    ]);
    expect(sameClassFallback("withdrawn", kept, list)).toBe("sibling");
    expect(
      sameClassFallback("withdrawn", { ...kept, retainsData: true }, list),
    ).toBe("keeps");
    expect(
      sameClassFallback("withdrawn", { ...kept, provider: "Provider C" }, list),
    ).toBeUndefined();
  });

  test("a listed model's class comes from the list", () => {
    expect(classOf(model("m", { outsideRegion: true }))).toEqual({
      provider: "Provider A",
      outsideRegion: true,
      retainsData: false,
    });
    expect(classOf({ id: "m", displayName: "m" })).toBeNull();
  });
});
