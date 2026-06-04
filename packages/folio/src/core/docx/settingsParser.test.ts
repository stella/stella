import { describe, expect, test } from "bun:test";

import { DEFAULT_TAB_STOP_TWIPS, parseSettings } from "./settingsParser";

const SETTINGS_HEAD = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:settings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">`;
const SETTINGS_TAIL = `</w:settings>`;

function wrap(inner: string): string {
  return `${SETTINGS_HEAD}${inner}${SETTINGS_TAIL}`;
}

describe("parseSettings — w:defaultTabStop (§17.6.13)", () => {
  test("returns OOXML default when settings.xml is missing", () => {
    expect(parseSettings(null).defaultTabStop).toBe(DEFAULT_TAB_STOP_TWIPS);
  });

  test("returns OOXML default when w:defaultTabStop element is absent", () => {
    expect(parseSettings(wrap("")).defaultTabStop).toBe(DEFAULT_TAB_STOP_TWIPS);
  });

  test("parses w:defaultTabStop val attribute", () => {
    expect(
      parseSettings(wrap(`<w:defaultTabStop w:val="1440"/>`)).defaultTabStop,
    ).toBe(1440);
  });

  test("ignores non-positive values (Word never emits them)", () => {
    expect(
      parseSettings(wrap(`<w:defaultTabStop w:val="0"/>`)).defaultTabStop,
    ).toBe(DEFAULT_TAB_STOP_TWIPS);
    expect(
      parseSettings(wrap(`<w:defaultTabStop w:val="-100"/>`)).defaultTabStop,
    ).toBe(DEFAULT_TAB_STOP_TWIPS);
  });

  test("ignores non-numeric values", () => {
    expect(
      parseSettings(wrap(`<w:defaultTabStop w:val="banana"/>`)).defaultTabStop,
    ).toBe(DEFAULT_TAB_STOP_TWIPS);
  });

  test("ignores values beyond Word's maximum margin (~22 inches)", () => {
    // 50000 twips ≈ 34.7 inches — past any plausible page width; reject.
    expect(
      parseSettings(wrap(`<w:defaultTabStop w:val="50000"/>`)).defaultTabStop,
    ).toBe(DEFAULT_TAB_STOP_TWIPS);
  });
});

describe("parseSettings — w:evenAndOddHeaders (§17.10.1)", () => {
  test("absent flag leaves evenAndOddHeaders undefined", () => {
    expect(parseSettings(wrap("")).evenAndOddHeaders).toBeUndefined();
    expect(parseSettings(null).evenAndOddHeaders).toBeUndefined();
  });

  test("a bare element records the on state", () => {
    expect(
      parseSettings(wrap(`<w:evenAndOddHeaders/>`)).evenAndOddHeaders,
    ).toBe(true);
  });

  test('an explicit w:val="0" is treated as off', () => {
    expect(
      parseSettings(wrap(`<w:evenAndOddHeaders w:val="0"/>`)).evenAndOddHeaders,
    ).toBeUndefined();
  });
});
