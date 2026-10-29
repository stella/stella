import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { ciGeneratedFiles } from "./generated-file-inventory";
import { CI_GENERATED_FILES } from "./generated-files";

test("inventories derived MCP outputs before they exist and follows source additions and removals", () => {
  const root = mkdtempSync(path.join(tmpdir(), "generated-inventory-"));
  const write = (file: string) => {
    const destination = path.join(root, file);
    mkdirSync(path.dirname(destination), { recursive: true });
    writeFileSync(destination, "");
  };
  try {
    expect(ciGeneratedFiles(root)).toEqual([...CI_GENERATED_FILES].toSorted());
    write("packages/cli/capabilities/example.read.json");
    write("packages/cli/capabilities/README.md");
    write("packages/mcp-apps/src/reader/app.html");
    write("packages/mcp-apps/src/shared/generated/style.css.d.ts");
    write("packages/mcp-apps/src/shared/generated/tsconfig.json");
    const expected = [
      ...CI_GENERATED_FILES,
      "apps/api/src/mcp/generated/capability-dispatch/example.read.ts",
      "packages/mcp-apps/src/reader/generated/app.html.txt",
      "packages/mcp-apps/src/reader/generated/app.js.txt",
      "packages/mcp-apps/src/reader/generated/app.css.txt",
      "packages/mcp-apps/src/shared/generated/messages.json",
      "packages/mcp-apps/src/shared/generated/schemas.json",
      "packages/mcp-apps/src/shared/generated/contracts.js",
      "packages/mcp-apps/src/shared/generated/contracts.d.ts",
      "packages/mcp-apps/src/shared/generated/reader-messages.json",
      "packages/mcp-apps/src/shared/generated/reader-inputs.json",
      "packages/mcp-apps/src/shared/generated/style.css",
      "packages/mcp-apps/src/generated/runtime.js.txt",
      "packages/mcp-apps/src/generated/runtime.css.txt",
      "packages/mcp-apps/src/generated/bundles.ts",
    ].toSorted();
    expect(ciGeneratedFiles(root)).toEqual(expected);
    write("packages/mcp-apps/src/reader/generated/app.html.txt");
    write("apps/api/src/mcp/generated/capability-dispatch/stale.ts");
    expect(ciGeneratedFiles(root)).toEqual(expected);
    rmSync(path.join(root, "packages/cli/capabilities/example.read.json"));
    rmSync(path.join(root, "packages/mcp-apps/src/reader/app.html"));
    expect(ciGeneratedFiles(root)).toEqual(
      expected.filter(
        (file) =>
          file !==
            "apps/api/src/mcp/generated/capability-dispatch/example.read.ts" &&
          !file.startsWith("packages/mcp-apps/src/reader/generated/"),
      ),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
