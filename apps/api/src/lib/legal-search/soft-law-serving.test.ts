import { describe, expect, test } from "bun:test";

import { GUIDANCE_KINDS } from "@stll/legal-ast/document-kind";

import { SOFT_LAW_ADMISSIONS } from "@/api/handlers/soft-law/adapters/registry";

import {
  hasSoftLawSetting,
  SOFT_LAW_AI_USE,
  SOFT_LAW_READ_SURFACE,
  SOFT_LAW_SERVE_MODE,
  SOFT_LAW_SERVING_SETTINGS,
  softLawAccessOf,
  type SoftLawServingSetting,
  softLawServingSettingOf,
  softLawSurfaceEntries,
} from "./soft-law-serving";
import { SOFT_LAW_AUTHORITIES } from "./soft-law-types";

const SERVED_SOURCES = ["cz-suip", "cz-uoou", "eu-edpb"];

const attribution = {
  text: "Publisher",
  termsUrl: null,
  conditions: [],
  summaryDisclaimer: null,
};

const fullSetting = (
  ai: (typeof SOFT_LAW_AI_USE)[keyof typeof SOFT_LAW_AI_USE],
) =>
  ({
    serve: SOFT_LAW_SERVE_MODE.full,
    ai,
    attribution,
    withheldKinds: ["inspection_report"],
  }) satisfies SoftLawServingSetting;

describe("soft-law serving census", () => {
  test("every authority and admission has exactly one setting", () => {
    const settings = Object.keys(SOFT_LAW_SERVING_SETTINGS).toSorted();
    expect(settings).toEqual(Object.keys(SOFT_LAW_AUTHORITIES).toSorted());
    expect(settings).toEqual(Object.keys(SOFT_LAW_ADMISSIONS).toSorted());
  });

  test("only the assigned sources are served", () => {
    const served = Object.entries(SOFT_LAW_SERVING_SETTINGS)
      .filter(([, setting]) => setting.serve !== SOFT_LAW_SERVE_MODE.none)
      .map(([authority]) => authority)
      .toSorted();
    expect(served).toEqual(SERVED_SOURCES);
  });

  test("a served source carries the attribution shown with its results", () => {
    for (const authority of SERVED_SOURCES) {
      const setting = softLawServingSettingOf(authority);
      if (setting.serve === SOFT_LAW_SERVE_MODE.none) {
        throw new Error(`${authority} is not served`);
      }
      expect(setting.attribution.text.trim()).not.toBe("");
    }
  });
});

describe("soft-law access", () => {
  test("a stored authority without a setting is not served", () => {
    for (const authority of ["", "cz-unknown", "toString", "__proto__"]) {
      expect(hasSoftLawSetting(authority)).toBe(false);
      const setting = softLawServingSettingOf(authority);
      expect(setting.serve).toBe(SOFT_LAW_SERVE_MODE.none);
      for (const surface of Object.values(SOFT_LAW_READ_SURFACE)) {
        expect(softLawAccessOf(setting, { surface, kind: "guideline" })).toBe(
          "none",
        );
      }
    }
  });

  test.each([
    [SOFT_LAW_AI_USE.none, "text", "metadata", "metadata"],
    [SOFT_LAW_AI_USE.reading, "text", "text", "metadata"],
    [SOFT_LAW_AI_USE.generation, "text", "text", "text"],
  ] as const)("ai %s reaches each surface", (ai, people, mcp, chat) => {
    const setting = fullSetting(ai);
    const access = (surface: keyof typeof SOFT_LAW_READ_SURFACE) =>
      softLawAccessOf(setting, { surface, kind: "guideline" });
    expect(access("people")).toBe(people);
    expect(access("mcp")).toBe(mcp);
    expect(access("chat")).toBe(chat);
  });

  test("a withheld kind is hidden on every surface", () => {
    for (const surface of Object.values(SOFT_LAW_READ_SURFACE)) {
      expect(
        softLawAccessOf(fullSetting(SOFT_LAW_AI_USE.generation), {
          surface,
          kind: "inspection_report",
        }),
      ).toBe("none");
    }
  });

  test.each(["cz-uoou", "cz-suip"] as const)(
    "%s withholds its kinds that can name individuals",
    (authority) => {
      const setting = SOFT_LAW_SERVING_SETTINGS[authority];
      for (const kind of ["inspection_report", "other"]) {
        expect(
          softLawAccessOf(setting, {
            surface: SOFT_LAW_READ_SURFACE.people,
            kind,
          }),
        ).toBe("none");
      }
      expect(
        softLawAccessOf(setting, {
          surface: SOFT_LAW_READ_SURFACE.mcp,
          kind: "methodology",
        }),
      ).toBe("text");
    },
  );

  test("a metadata-link source never reaches text on any surface", () => {
    const setting = {
      serve: SOFT_LAW_SERVE_MODE.metadataLink,
      attribution,
    } satisfies SoftLawServingSetting;
    for (const surface of Object.values(SOFT_LAW_READ_SURFACE)) {
      for (const kind of GUIDANCE_KINDS) {
        expect(softLawAccessOf(setting, { surface, kind })).toBe("metadata");
      }
    }
  });

  test("the search filter of every surface lists only served sources", () => {
    for (const surface of Object.values(SOFT_LAW_READ_SURFACE)) {
      expect(
        softLawSurfaceEntries(surface)
          .map(({ authority }) => authority)
          .toSorted(),
      ).toEqual(SERVED_SOURCES);
    }
  });

  test("EDPB text reaches people, MCP and chat", () => {
    for (const surface of Object.values(SOFT_LAW_READ_SURFACE)) {
      expect(
        softLawAccessOf(SOFT_LAW_SERVING_SETTINGS["eu-edpb"], {
          surface,
          kind: "guideline",
        }),
      ).toBe("text");
    }
  });
});
