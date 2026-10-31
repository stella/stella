import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import config from "../../oxlint.config.ts";
import { lintSingleRule } from "./lint-single-rule.ts";

const lint = async (source: string, sourcePath = "scripts/path-consumer.ts") =>
  await lintSingleRule("no-raw-path-relative", source, { sourcePath });

const MULTILINE_RELATIVE = [
  'import path from "node:path";',
  "const relative = path.relative(",
  "  root,",
  "  file,",
  ");",
].join("\n");

for (const { name, now, changedLines, diagnostics } of [
  {
    name: "unchanged during rollout",
    now: "2026-10-14",
    changedLines: [],
    diagnostics: [],
  },
  {
    name: "changed inside the call during rollout",
    now: "2026-10-14",
    changedLines: [4],
    diagnostics: [2],
  },
  {
    name: "unchanged after rollout expiry",
    now: "2026-10-21",
    changedLines: [],
    diagnostics: [2],
  },
]) {
  test(`multiline raw relative call: ${name}`, async () => {
    const directory = await mkdtemp(
      path.join(tmpdir(), "portable-path-rollout-"),
    );
    const wrapper = path.join(directory, "plugin.ts");
    const plugin = path.resolve(
      import.meta.dirname,
      "../no-raw-path-relative.ts",
    );
    const scope = path.resolve(
      import.meta.dirname,
      "../../scripts/guard-rollouts.ts",
    );
    const portablePath = path.resolve(
      import.meta.dirname,
      "../../packages/portable-path/src/index.ts",
    );
    const repository = path.resolve(import.meta.dirname, "../..");
    // Inject clock and diff inputs; oxlint still executes the production detector and scope helper.
    await Bun.write(
      wrapper,
      `import { createPortablePathPlugin } from ${JSON.stringify(plugin)};
import { guardEnforcesLine } from ${JSON.stringify(scope)};
import { repoRelativePath } from ${JSON.stringify(portablePath)};
export default createPortablePathPlugin((options) => guardEnforcesLine({
  ...options,
  rollouts: [{ id: "portable-path", type: "changed-lines", expiresAt: "2026-10-20T00:00:00.000Z", check: ["bun", "scripts/check-fixture.ts"] }],
  now: new Date(${JSON.stringify(now)}),
  changedLines: new Map([[repoRelativePath(${JSON.stringify(repository)}, options.file), new Set(${JSON.stringify(changedLines)})]]),
}));
`,
    );
    try {
      expect(
        await lintSingleRule("no-raw-path-relative", MULTILINE_RELATIVE, {
          sourcePath: "scripts/path-consumer.ts",
          pluginPath: wrapper,
        }),
      ).toEqual(diagnostics);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
}

test("reports raw relative calls through identifiers", async () => {
  expect(
    await lint(
      'import path from "node:path";\nconst relative = path.relative;\nrelative(root, file);',
    ),
  ).toEqual([3]);
});

test("reports injected path relative calls", async () => {
  expect(
    await lint(
      'import path from "node:path";\nconst locate = (root, file, pathApi = path) => pathApi.relative(root, file);',
    ),
  ).toEqual([2]);
});

test("reports native separators combined with portable identifiers", async () => {
  expect(
    await lint(
      'import path from "node:path";\nimport { repoRelativePath } from "@stll/portable-path";\nconst relative = repoRelativePath(root, file);\nrelative + path.sep;',
    ),
  ).toEqual([4]);
});

test("accepts portable helpers and the owner module", async () => {
  expect(
    await lint(
      'import { repoRelativePath } from "@stll/portable-path";\nrepoRelativePath(root, file);',
    ),
  ).toEqual([]);
  expect(
    await lint(
      'import path from "node:path";\npath.relative(root, file);',
      "packages/portable-path/src/index.ts",
    ),
  ).toEqual([]);
});

test("only the published loader is exempt in the repository configuration", async () => {
  const rule = "no-raw-path-relative/no-raw-path-relative";
  const overrides = config.overrides.filter(
    (override) => override.rules !== undefined && rule in override.rules,
  );
  const source = 'import path from "node:path";\npath.relative(root, file);';
  const results = await Promise.all(
    (
      [
        ["packages/start-runtime/src/local-module-loader.ts", null],
        ["packages/start-runtime/src/another-loader.ts", 2],
        ["packages/start-runtime/src/nested/local-module-loader.ts", 2],
      ] as const
    ).map(async (lintCase, index) => {
      const [sourcePath, expectedLine] = lintCase;

      return {
        label: `case ${index + 1}: ${JSON.stringify(lintCase)}`,
        result: await lintSingleRule("no-raw-path-relative", source, {
          sourcePath,
          overrides,
          cwd: "scratch",
        }),
        expected: expectedLine === null ? [] : [expectedLine],
      };
    }),
  );
  expect(results.map(({ label, result }) => ({ label, result }))).toEqual(
    results.map(({ label, expected }) => ({ label, result: expected })),
  );
});
