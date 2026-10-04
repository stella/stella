import { panic } from "better-result";
import { afterEach, describe, expect, test } from "bun:test";
import { statSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import oxlintConfig from "../oxlint.config.ts";
import {
  approvedAdapterPathErrors,
  approvedAdapterPaths,
  redeclaredSharedHelpers,
  ruleNamesFromSource,
} from "./check-oxlint-plugin-registry.ts";

const temporaryDirectories: string[] = [];
const TYPEBOX_UNSAFE_RULE_ID =
  "no-unreviewed-typebox-unsafe/no-unreviewed-typebox-unsafe";

describe("plugin rule census", () => {
  test("derives literal and computed rule names independently of formatting or factory nesting", () => {
    for (const indentation of ["", "  ", "    ", "      ", "\t"]) {
      const rules = `rules: {\n${indentation}"literal-rule": {},\n${indentation}[RULE_NAME]: {}\n}`;
      for (const source of [
        `const RULE_NAME = "computed-rule"; export default { ${rules} };`,
        `const RULE_NAME = "computed-rule"; const createPlugin = () => ({ ${rules} }); export default createPlugin();`,
      ]) {
        expect(ruleNamesFromSource(source)).toEqual([
          "literal-rule",
          "computed-rule",
        ]);
      }
    }
  });

  test("does not derive rules from comments, strings, other objects or unresolved keys", () => {
    expect(
      ruleNamesFromSource(`
      // rules: { "comment-rule": {} }
      const text = 'rules: { "string-rule": {} }';
      const messages = { "message-rule": {} };
      export default { rules: { [UNKNOWN]: {} } };
    `),
    ).toEqual([]);
  });
});

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map(
        async (directory) =>
          await rm(directory, { force: true, recursive: true }),
      ),
  );
});

const isFileIn = (directory: string, sourcePath: string): boolean =>
  statSync(path.join(directory, sourcePath), {
    throwIfNoEntry: false,
  })?.isFile() ?? false;

describe("TypeBox approved adapter path census", () => {
  test("covers every adapter path declared by the real Oxlint configuration", async () => {
    const paths = approvedAdapterPaths(oxlintConfig);
    const missingPath = paths.at(0);
    if (missingPath === undefined) {
      panic("oxlint config has no approved TypeBox adapter paths");
    }

    const directory = await mkdtemp(
      path.join(tmpdir(), "stella-oxlint-adapter-paths-"),
    );
    temporaryDirectories.push(directory);
    for (const sourcePath of paths) {
      const destination = path.join(directory, sourcePath);
      await mkdir(path.dirname(destination), { recursive: true });
      await copyFile(sourcePath, destination);
    }

    expect(
      approvedAdapterPathErrors(oxlintConfig, (sourcePath) =>
        isFileIn(directory, sourcePath),
      ),
    ).toEqual([]);

    await rm(path.join(directory, missingPath));

    expect(
      approvedAdapterPathErrors(oxlintConfig, (sourcePath) =>
        isFileIn(directory, sourcePath),
      ),
    ).toEqual([
      `oxlint.config.ts: approved TypeBox adapter path does not exist: ${missingPath}`,
    ]);
  });

  test("checks top-level rules and rejects directories as adapter paths", async () => {
    const directory = await mkdtemp(
      path.join(tmpdir(), "stella-oxlint-adapter-directory-"),
    );
    temporaryDirectories.push(directory);
    const lintConfig = {
      rules: {
        [TYPEBOX_UNSAFE_RULE_ID]: [
          "error",
          {
            approvedAdapters: [
              {
                binding: "reviewed",
                path: directory,
                reason: "Fixture-approved adapter boundary.",
              },
            ],
          },
        ],
      },
    };

    expect(approvedAdapterPaths(lintConfig)).toEqual([directory]);
    expect(approvedAdapterPathErrors(lintConfig)).toEqual([
      `oxlint.config.ts: approved TypeBox adapter path does not exist: ${directory}`,
    ]);
  });
});

describe("shared helper redeclarations", () => {
  const helpers = ["AstNode", "isAstNode", "resolveVariable"];

  test("reports local declarations of shared helper names", () => {
    const source = [
      "type AstNode = { type: string };",
      "const isAstNode = (node: unknown) => true;",
      "function resolveVariable(identifier) {}",
    ].join("\n");
    expect(redeclaredSharedHelpers(source, helpers)).toEqual(helpers);
  });

  test("accepts imports of shared helper names", () => {
    const source =
      'import { type AstNode, isAstNode } from "./utils.ts";\nisAstNode(x);';
    expect(redeclaredSharedHelpers(source, helpers)).toEqual([]);
  });
});
