import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { createTranslator } from "use-intl";

import { filterCatalogueByKind } from "@stll/catalogue";

import {
  NATIVE_TOOL_COPY,
  nativeToolDescriptionKey,
  nativeToolLabelKey,
} from "@/components/catalogue/native-tool-label";
import englishMessages from "@/i18n/langs/en.json";

const manifests = filterCatalogueByKind("native-tool");
const english = createTranslator({ locale: "en", messages: englishMessages });

const LANGS_DIR = path.join(import.meta.dirname, "../../i18n/langs");
const otherLocales = readdirSync(LANGS_DIR)
  .filter((file) => file.endsWith(".json") && file !== "en.json")
  .map((file) => ({
    file,
    messages: JSON.parse(readFileSync(path.join(LANGS_DIR, file), "utf-8")),
  }));

const lastSegment = (key: string) => key.split(".").at(-1) ?? "";

describe("native tool copy", () => {
  test("covers exactly the native tools in the catalogue", () => {
    expect(Object.keys(NATIVE_TOOL_COPY).toSorted()).toEqual(
      manifests.map(({ slug }) => slug).toSorted(),
    );
  });

  test("the English catalog repeats each manifest word for word", () => {
    for (const entry of manifests) {
      const descriptionKey = nativeToolDescriptionKey(entry);
      const labelKey = nativeToolLabelKey(entry);
      expect(
        descriptionKey === undefined ? undefined : english(descriptionKey),
      ).toBe(entry.description);
      expect(
        labelKey === undefined ? entry.displayName : english(labelKey),
      ).toBe(entry.displayName);
    }
  });

  test("every other language has its own description for every tool", () => {
    expect(otherLocales.length).toBeGreaterThan(0);
    for (const entry of manifests) {
      const key = nativeToolDescriptionKey(entry);
      expect(key).toBeDefined();
      const field = lastSegment(key ?? "");
      for (const { file, messages } of otherLocales) {
        const translated = messages.catalogue.toolDescriptions[field];
        expect(`${file} ${field} ${translated === entry.description}`).toBe(
          `${file} ${field} false`,
        );
      }
    }
  });

  test("anything that is not a shipped native tool keeps its own text", () => {
    const unknownTool = { kind: "native-tool", slug: "not-a-tool" };
    const server = { kind: "mcp", slug: "ares" };
    expect(nativeToolLabelKey(unknownTool)).toBeUndefined();
    expect(nativeToolDescriptionKey(unknownTool)).toBeUndefined();
    expect(nativeToolLabelKey(server)).toBeUndefined();
    expect(nativeToolDescriptionKey(server)).toBeUndefined();
  });

  test("a proper name has no key, so it reads the same everywhere", () => {
    expect(nativeToolLabelKey({ kind: "native-tool", slug: "ares" })).toBe(
      undefined,
    );
  });
});
