import tailwindcss from "@tailwindcss/postcss";
import { expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postcss from "postcss";

import { MCP_APPS } from "../src/mcp/apps/manifest";

test("MCP styles stay unchanged when generated bundles contain stale utilities", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "mcp-app-styles-"));
  try {
    const appsRoot = path.join(root, "apps/api/src/mcp/apps");
    const stylePath = path.join(appsRoot, "shared/style.css");
    const uiRoot = path.join(root, "packages/ui/src");
    mkdirSync(path.dirname(stylePath), { recursive: true });
    mkdirSync(uiRoot, { recursive: true });
    mkdirSync(path.join(appsRoot, "case-law-results"), { recursive: true });
    writeFileSync(
      path.join(appsRoot, "case-law-results/app.tsx"),
      '<div className="leading-3.5" />',
    );
    writeFileSync(path.join(uiRoot, "badge.tsx"), '<div className="px-1" />');

    const tailwindPath = fileURLToPath(
      import.meta.resolve("tailwindcss/index.css"),
    )
      .split(path.sep)
      .join("/");
    // Resolve dependencies outside the fixture while retaining the real scan policy.
    const input = readFileSync(
      path.join(import.meta.dirname, "../src/mcp/apps/shared/style.css"),
      "utf-8",
    )
      .replace('"tailwindcss"', () => JSON.stringify(tailwindPath))
      .replace('@import "@stll/ui/theme.css";', "");
    writeFileSync(stylePath, input);
    const compile = async () =>
      (await postcss([tailwindcss()]).process(input, { from: stylePath })).css;
    const clean = await compile();
    expect(clean).toContain(".leading-3\\.5");
    expect(clean).toContain(".px-1");
    expect(clean).not.toContain(".leading-3 {");

    for (const { directory } of MCP_APPS) {
      const generated = path.join(appsRoot, directory, "generated");
      mkdirSync(generated, { recursive: true });
      writeFileSync(
        path.join(generated, "app.html.txt"),
        `<style>${clean}</style><div class="mt-97"></div>`,
      );
    }

    expect(await compile()).toBe(clean);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
