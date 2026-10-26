import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

import { matterChromeStyle } from "@stll/ui/matter-colors";

test("the root declares every matter tint variable as its no-matter value", () => {
  const css = readFileSync(path.join(import.meta.dir, "app.css"), "utf-8");
  const rootDeclarations = [...css.matchAll(/^:root \{([^}]*)\}/gmu)]
    .map(([, body = ""]) => body)
    .join("\n");

  for (const [name, value] of Object.entries(matterChromeStyle(null))) {
    expect(rootDeclarations).toContain(`${name}: ${String(value)};`);
  }
});
