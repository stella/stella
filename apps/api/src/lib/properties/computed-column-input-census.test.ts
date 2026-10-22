import { describe, expect, test } from "bun:test";

const OWNED_PROPERTY_WRITERS = [
  "../../handlers/properties/create.ts",
  "../../handlers/properties/batch/create.ts",
  "../../handlers/properties/update.ts",
  "../workflow/materialize-playbook-run.ts",
  "../views/template-properties.ts",
  "../../handlers/workspaces/duplicate.ts",
] as const;

describe("computed column input owner census", () => {
  for (const relativePath of OWNED_PROPERTY_WRITERS) {
    test(`${relativePath} delegates computed inputs to the owner`, async () => {
      const url = new URL(relativePath, import.meta.url);
      const source = await Bun.file(url).text();
      const ownerCall = "requireComputedColumnInputs({";
      const line = source
        .slice(0, source.indexOf(ownerCall))
        .split("\n").length;

      expect(
        source.includes(ownerCall),
        `${url.pathname}:${line}: property tool/dependency writer bypasses the computed-column input owner`,
      ).toBe(true);
    });
  }

  for (const relativePath of [
    "../../handlers/properties/create.ts",
    "../../handlers/properties/batch/create.ts",
    "../../handlers/properties/update.ts",
    "../../handlers/workspaces/duplicate.ts",
  ] as const) {
    test(`${relativePath} preserves the owner's HTTP refusal`, async () => {
      const source = await Bun.file(
        new URL(relativePath, import.meta.url),
      ).text();
      expect(source).toContain("computedColumnInputHandlerError(");
    });
  }
});
