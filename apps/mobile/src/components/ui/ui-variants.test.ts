import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

import { BUTTON_VARIANTS } from "./button-variants";

const WEB_BUTTON = path.resolve(
  import.meta.dir,
  "../../../../../packages/ui/src/components/button.tsx",
);

/** The keys of the web button's `variant: { ... }` map. */
const webButtonVariants = (): string[] => {
  const source = readFileSync(WEB_BUTTON, "utf-8");
  const start = source.indexOf("      variant: {");
  const block = source.slice(start, source.indexOf("\n      },", start));
  return [...block.matchAll(/^ {8}"?([\w-]+)"?:/gmu)]
    .map((match) => match[1] ?? "")
    .toSorted();
};

test("the app's buttons come in exactly the web's variants", () => {
  expect(webButtonVariants().length).toBeGreaterThan(3);
  expect(Object.keys(BUTTON_VARIANTS).toSorted()).toEqual(webButtonVariants());
});
