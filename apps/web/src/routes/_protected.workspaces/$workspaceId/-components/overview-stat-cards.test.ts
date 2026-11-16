import { expect, test } from "bun:test";

import english from "@/i18n/langs/en.json";

const source = await Bun.file(`${import.meta.dir}/overview-view.tsx`).text();

test("every overview stat card uses a static label without its value", () => {
  const statGrid = source.slice(
    source.indexOf("{/* Stats grid */}"),
    source.indexOf("{/* Two-column layout"),
  );
  const cards = statGrid.match(/<StatCard\b/gu) ?? [];
  const labelKeys = Array.from(
    statGrid.matchAll(/\blabel="([^"]+)"/gu),
    (match) => match[1] ?? "",
  );

  expect(labelKeys).toHaveLength(cards.length);
  for (const labelKey of labelKeys) {
    let label: unknown = english;
    for (const segment of labelKey.split(".")) {
      label =
        typeof label === "object" && label !== null
          ? Reflect.get(label, segment)
          : undefined;
    }
    expect(typeof label).toBe("string");
    expect(label).not.toMatch(/\{[^}]+\}|\d/u);
  }
});
