import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";

import {
  COLUMN_SORT_KINDS,
  SORT_DIRECTIONS,
} from "@stll/api-contract/column-sort";

import { SORT_DIRECTION_LABEL_KEYS } from "@/components/workspaces/properties/sort-property.logic";

const LANGS_DIR = new URL("../../../i18n/langs/", import.meta.url);

const readCatalog = (file: string): unknown =>
  JSON.parse(readFileSync(new URL(file, LANGS_DIR), "utf-8"));

const catalogs = readdirSync(LANGS_DIR)
  .filter((file) => file.endsWith(".json"))
  .map((file) => ({
    locale: file.replace(/\.json$/u, ""),
    messages: readCatalog(file),
  }));

const childAt = (node: unknown, part: string): unknown =>
  typeof node === "object" && node !== null
    ? Object.entries(node).find(([key]) => key === part)?.[1]
    : undefined;

/** The message a dotted key names, or undefined where the catalog has none. */
const messageAt = (messages: unknown, key: string): unknown => {
  let node = messages;
  for (const part of key.split(".")) {
    node = childAt(node, part);
  }
  return node;
};

describe("the sort items' labels", () => {
  test("every catalog is read", () => {
    expect(catalogs.map(({ locale }) => locale)).toContain("en");
    expect(catalogs.length).toBeGreaterThan(1);
  });

  test.each(
    catalogs.flatMap(({ locale, messages }) =>
      COLUMN_SORT_KINDS.map((kind) => [locale, kind, messages] as const),
    ),
  )(
    "%s names both orders of a %s column, and names them apart",
    (_locale, kind, messages) => {
      const labels = SORT_DIRECTIONS.map((direction) =>
        messageAt(messages, SORT_DIRECTION_LABEL_KEYS[kind][direction]),
      );
      for (const label of labels) {
        expect(typeof label).toBe("string");
        expect(String(label).trim()).not.toBe("");
      }
      expect(new Set(labels).size).toBe(SORT_DIRECTIONS.length);
    },
  );

  test("no two kinds share a wording, so each label says what its order means", () => {
    const english = catalogs.find(({ locale }) => locale === "en")?.messages;
    const wordings = COLUMN_SORT_KINDS.map((kind) =>
      SORT_DIRECTIONS.map((direction) =>
        messageAt(english, SORT_DIRECTION_LABEL_KEYS[kind][direction]),
      ).join(" / "),
    );
    expect(new Set(wordings).size).toBe(COLUMN_SORT_KINDS.length);
  });
});
