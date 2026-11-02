import { describe, expect, test } from "bun:test";

import { DEFAULT_FILE_PROPERTY_NAME } from "@stll/api-contract/property-policy";

import { propertyDisplayName } from "@/lib/workspaces/property-display-name";

const FILE = { type: "file" };
const TEXT = { type: "text" };
const LABEL = "Dokumenty";

describe("what a column is called on screen", () => {
  test("the file column follows the reader while it keeps its default name", () => {
    expect(
      propertyDisplayName(
        { content: FILE, name: DEFAULT_FILE_PROPERTY_NAME },
        LABEL,
      ),
    ).toBe(LABEL);
  });

  test("a renamed file column keeps the name it was given", () => {
    expect(propertyDisplayName({ content: FILE, name: "Spis" }, LABEL)).toBe(
      "Spis",
    );
  });

  test("another column that happens to share the name stays as written", () => {
    expect(
      propertyDisplayName(
        { content: TEXT, name: DEFAULT_FILE_PROPERTY_NAME },
        LABEL,
      ),
    ).toBe(DEFAULT_FILE_PROPERTY_NAME);
  });
});
