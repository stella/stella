// bun fmt looks for a Prettier or oxfmt config file in every directory above
// the file it formats, past this repository root, and without one it picks
// oxfmt's defaults over Prettier's when an enclosing package.json depends on
// oxfmt. A checkout nested inside another checkout (a worktree under the main
// checkout, say) then formats differently from CI and rewrites files nobody
// changed. The root .prettierrc.yml ends that lookup here; this test formats
// the same source inside a directory full of conflicting formatter config
// and alone, and requires the same bytes.

import { describe, expect, test } from "bun:test";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dir, "..");
const STOPPER = ".prettierrc.yml";
// Everything at the repository root the formatter reads for a TypeScript file.
const ROOT_INPUTS = ["bunfig.toml", ".editorconfig", "package.json", STOPPER];

// Each line differs between Prettier's and oxfmt's defaults or under the
// enclosing config below (width, semicolons, union layout, indentation).
const SAMPLE = [
  "type CryptoExportSource =",
  '  { type: "expression"; value: unknown } | { type: "path"; value: string };',
  "",
  "export const describeSource = (source: CryptoExportSource): string => {",
  '  return source.type === "path" ? String(source.value) : "expression";',
  "};",
  "",
].join("\n");

// A parent directory that would change the output if any of it applied.
const HOSTILE_PARENT: Record<string, string> = {
  "package.json": `${JSON.stringify({
    name: "enclosing-checkout",
    private: true,
    devDependencies: { oxfmt: "0.72.0", prettier: "3.0.0" },
    prettier: { printWidth: 40, semi: false },
  })}\n`,
  ".oxfmtrc.json": '{ "printWidth": 40, "semi": false }\n',
  ".prettierrc": '{ "printWidth": 40, "semi": false }\n',
  ".editorconfig": "[*]\nindent_size = 8\nmax_line_length = 40\n",
  "bunfig.toml": "[fmt]\nprintWidth = 40\nsemi = false\n",
};

const format = (cwd: string): string => {
  const sample = path.join(cwd, "src", "sample.ts");
  mkdirSync(path.dirname(sample), { recursive: true });
  writeFileSync(sample, SAMPLE);
  const result = Bun.spawnSync(
    [process.execPath, "fmt", "--stdin-filepath", "src/sample.ts"],
    { cwd, stdin: Bun.file(sample), stdout: "pipe", stderr: "pipe" },
  );
  expect({
    exitCode: result.exitCode,
    stderr: result.stderr.toString(),
  }).toMatchObject({ exitCode: 0 });
  return result.stdout.toString();
};

const copyRootInputs = (to: string, inputs: readonly string[]) => {
  mkdirSync(to, { recursive: true });
  for (const file of inputs) {
    copyFileSync(path.join(REPO_ROOT, file), path.join(to, file));
  }
};

const withDirectory = (check: (directory: string) => void) => {
  const directory = mkdtempSync(path.join(tmpdir(), "formatter-config-root-"));
  try {
    check(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
};

describe("formatter config resolution", () => {
  test("a checkout nested under conflicting formatter config formats like one standing alone", () => {
    withDirectory((directory) => {
      const alone = path.join(directory, "alone");
      copyRootInputs(alone, ROOT_INPUTS);

      const parent = path.join(directory, "parent");
      mkdirSync(parent);
      for (const [file, text] of Object.entries(HOSTILE_PARENT)) {
        writeFileSync(path.join(parent, file), text);
      }
      const nested = path.join(parent, "worktrees", "nested");
      copyRootInputs(nested, ROOT_INPUTS);

      const expected = format(alone);
      expect(expected).toBe(SAMPLE);
      expect(format(nested)).toBe(expected);
    });
  });

  test("without the root stopper the enclosing config leaks in", () => {
    // Proves the test above can fail: drop the stopper and the hostile
    // parent changes the output.
    withDirectory((directory) => {
      const parent = path.join(directory, "parent");
      mkdirSync(parent);
      for (const [file, text] of Object.entries(HOSTILE_PARENT)) {
        writeFileSync(path.join(parent, file), text);
      }
      const nested = path.join(parent, "nested");
      copyRootInputs(
        nested,
        ROOT_INPUTS.filter((file) => file !== STOPPER),
      );
      expect(format(nested)).not.toBe(SAMPLE);
    });
  });

  test("the stopper holds no options of its own", () => {
    // bunfig.toml [fmt] is the one place formatter options live.
    const text = readFileSync(path.join(REPO_ROOT, STOPPER), "utf-8");
    const body = text
      .split("\n")
      .filter((line) => !line.startsWith("#") && line.trim() !== "");
    expect(body).toEqual(["{}"]);
    expect(
      readFileSync(path.join(REPO_ROOT, ".editorconfig"), "utf-8"),
    ).toMatch(/^root = true$/mu);
  });
});
