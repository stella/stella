import { expect, test } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import * as v from "valibot";

const root = path.resolve(import.meta.dir, "..");
const code = "require-file-property-policy(require-file-property-policy)";
const report = v.object({
  diagnostics: v.array(v.object({ code: v.string() })),
});
const owners = [
  "apps/api/src/handlers/properties/update.ts",
  "apps/api/src/handlers/properties/delete.ts",
  "apps/web/src/routes/_protected.workspaces/$workspaceId/-components/property-popover.logic.ts",
];

const lint = async (source: string, filename: string) => {
  const directory = await mkdtemp(path.join(tmpdir(), "stella-file-policy-"));
  try {
    const input = path.join(directory, filename);
    await mkdir(path.dirname(input), { recursive: true });
    await Bun.write(input, source);
    const config = path.join(directory, "oxlint.config.ts");
    await Bun.write(
      config,
      `export default ${JSON.stringify({
        categories: { correctness: "off" },
        jsPlugins: [
          path.join(root, ".oxlint-plugins/require-file-property-policy.ts"),
        ],
        rules: {
          "require-file-property-policy/require-file-property-policy": "error",
        },
      })};`,
    );
    const process = Bun.spawn(
      ["bun", "--bun", "oxlint", "-c", config, "--format", "json", input],
      { cwd: root, stdout: "pipe", stderr: "pipe" },
    );
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
      process.exited,
    ]);
    expect([0, 1]).toContain(exitCode);
    expect(stderr).not.toContain("Failed to load");
    return v
      .parse(report, JSON.parse(stdout))
      .diagnostics.map(({ code: diagnosticCode }) => diagnosticCode);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};

test.each(owners)("requires the shared classification in %s", async (owner) => {
  expect(
    await lint(await Bun.file(path.join(root, owner)).text(), owner),
  ).toEqual([]);
  expect(await lint("export const allowed = true;", owner)).toEqual([code]);
  expect(
    await lint(
      'import { isFileProperty } from "./local-policy"; export const allowed = isFileProperty(content);',
      owner,
    ),
  ).toEqual([code]);
  expect(
    await lint(
      'import { isFileProperty } from "@stll/api-contract/property-policy"; export const allowed = true;',
      owner,
    ),
  ).toEqual([code]);
  expect(
    await lint(
      'import { isFileProperty } from "@stll/api-contract/property-policy"; export const allowed = (isFileProperty: (value: unknown) => boolean) => isFileProperty(content);',
      owner,
    ),
  ).toEqual([code]);
  expect(
    await lint(
      'import { isFileProperty as classify } from "@stll/api-contract/property-policy"; export const allowed = classify(content);',
      owner,
    ),
  ).toEqual([]);
});

test.each([
  'content.type === "file"',
  '"file" !== content["type"]',
  '["file"].includes(content.type)',
  '(content.type === "file") as boolean',
  '(() => { switch (content.type) { case "file": return false; default: return true; } })()',
])("rejects duplicated file classification: %s", async (comparison) => {
  expect(
    await lint(
      `import { isFileProperty } from "@stll/api-contract/property-policy"; export const shared = isFileProperty(content); export const duplicate = ${comparison};`,
      "apps/api/src/handlers/properties/update.ts",
    ),
  ).toEqual([code]);
});

test("permits the literal outside classification boundaries", async () => {
  expect(
    await lint(
      'export const file = content.type === "file";',
      "apps/api/src/handlers/properties/create.ts",
    ),
  ).toEqual([]);
});
