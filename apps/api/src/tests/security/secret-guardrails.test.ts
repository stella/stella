import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const readRootFixture = (relativePath: string) =>
  readFileSync(join(import.meta.dir, "../../../../..", relativePath), "utf-8");

describe("secret guardrails", () => {
  test("log sink lint walks method receivers carrying secret identifiers", () => {
    const pluginSource = readRootFixture(
      ".oxlint-plugins/no-secret-in-log-sink.ts",
    );

    expect(pluginSource).toContain("apiKey.trim()");
    expect(pluginSource).toContain('node.callee?.type === "MemberExpression"');
    expect(pluginSource).toContain(
      "checkExpression(context, node.callee, contextLabel)",
    );
    expect(pluginSource).toContain("isMaskedSecretValue(prop.value)");
    expect(pluginSource).toContain(
      "checkExpression(context, prop.key, contextLabel)",
    );
  });

  test("secret brands are minted only at the MCP decrypt boundary", () => {
    const secretBrandsSource = readRootFixture(
      "apps/api/src/lib/secret-brands.ts",
    );
    const cryptoSource = readRootFixture(
      "apps/api/src/handlers/mcp-connectors/crypto.ts",
    );

    expect(secretBrandsSource).not.toContain("export const toSecret");
    expect(cryptoSource).toContain("const toDecryptedSecret");
    expect(cryptoSource).toContain("value as Secret<K>");
  });
});
