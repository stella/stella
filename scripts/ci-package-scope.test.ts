import { expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  markdownChecks,
  markdownReaders,
  requiresLandingBuild,
  requiresPackageChecks,
} from "./ci-package-scope";
import { importProblems } from "./install-free-ci";

const repository = (
  run: (root: string, write: (file: string, text: string) => void) => void,
) => {
  const root = mkdtempSync(path.join(tmpdir(), "ci-package-scope-"));
  const write = (file: string, text: string) => {
    const target = path.join(root, file);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, text);
  };
  try {
    write(
      "turbo.json",
      JSON.stringify({
        tasks: {
          "@stll/landing#build": {
            inputs: [
              "$TURBO_DEFAULT$",
              "$TURBO_ROOT$/docs/changelog/**",
              "$TURBO_ROOT$/scripts/media.ts",
            ],
          },
          "@stll/example#test": { inputs: ["$TURBO_ROOT$/docs/contract.md"] },
        },
      }),
    );
    write(
      "bun.lock",
      JSON.stringify({
        workspaces: {
          "apps/landing": {
            name: "@stll/landing",
            dependencies: { "@stll/ui": "workspace:*" },
          },
          "packages/ui": {
            name: "@stll/ui",
            devDependencies: { "@stll/base": "workspace:*" },
          },
          "packages/base": { name: "@stll/base" },
          "packages/unrelated": { name: "@stll/unrelated" },
        },
        packages: {
          "@stll/ui": ["@stll/ui@workspace:packages/ui"],
          "@stll/base": ["@stll/base@workspace:packages/base"],
          "@stll/unrelated": ["@stll/unrelated@workspace:packages/unrelated"],
        },
      }),
    );
    run(root, write);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};

test("ordinary markdown and changesets skip package checks while source content and declared docs retain them", () => {
  repository((root) => {
    for (const changed of [
      [],
      ["provenance/attestation.json"],
      ["docs/guide.md", ".changeset/fresh.md"],
      ["notes/guide.mdx", ".provenance.yml"],
      ["apps/example/README.md", "packages/example/README.md"],
      ["apps/api/src/prompt.md"],
    ]) {
      expect(requiresPackageChecks({ root, changed })).toBe(false);
    }
    for (const file of [
      "docs/contract.md",
      "docs/module-ownership.md",
      "docs/self-hosting.md",
      "docs/changelog/change.md",
      "docs/policies/access.md",
      ".changeset/README.md",
      "AGENTS.md",
      ".ai/local/guide.md",
      ".agents/skills/new/SKILL.md",
      "docs/unrecognized.weird",
      ".provenance.yml.ts",
    ]) {
      expect(requiresPackageChecks({ root, changed: [file] }), file).toBe(true);
      expect(
        requiresPackageChecks({ root, changed: ["docs/guide.md", file] }),
        file,
      ).toBe(true);
    }
  });
});

test("source and unknown paths retain package checks alone or with documentation", () => {
  repository((root) => {
    for (const file of [
      "apps/api/src/index.ts",
      "packages/x/src/a.ts",
      "scripts/a.ts",
      "railway/template.json",
      ".oxlint-plugins/rule.ts",
      "docs/unrecognized.weird",
      ".provenance.yml.ts",
    ]) {
      for (const changed of [
        [file],
        ["README.md", file],
        [file, "apps/desktop/README.md"],
      ]) {
        expect(
          requiresPackageChecks({ root, changed }),
          changed.join(", "),
        ).toBe(true);
      }
    }
  });
});

test("a planted markdown reader joins isolated checks, including deleted input files", () => {
  repository((root, write) => {
    expect(requiresPackageChecks({ root, changed: ["docs/planted.md"] })).toBe(
      false,
    );
    write(
      "scripts/reader.test.ts",
      'import { readFileSync } from "node:fs"; const source = readFileSync("../docs/planted.md", "utf8");',
    );
    expect(requiresPackageChecks({ root, changed: ["docs/planted.md"] })).toBe(
      false,
    );
    expect(markdownChecks({ root, changed: ["docs/planted.md"] })).toEqual([
      ["bun", "test", "scripts/reader.test.ts"],
    ]);
    expect(requiresPackageChecks({ root, changed: ["docs/unread.md"] })).toBe(
      false,
    );
    write("scripts/readme.test.ts", 'const source = Bun.file("README.md");');
    expect(requiresPackageChecks({ root, changed: ["README.md"] })).toBe(false);
    expect(markdownChecks({ root, changed: ["README.md"] })).toEqual([
      ["bun", "test", "scripts/readme.test.ts"],
    ]);
  });
});

test("the exact README change derives both genuine readers without package jobs", () => {
  const changed = ["README.md", "apps/desktop/README.md"];
  expect(requiresPackageChecks({ changed })).toBe(false);
  const checks = markdownChecks({ changed });
  expect(checks).toHaveLength(4);
  expect(checks).toContainEqual([
    "bun",
    "scripts/check-railway-template-shape.ts",
  ]);
  expect(checks).toContainEqual([
    "bun",
    "test",
    "scripts/capability-catalog-readers.test.ts",
  ]);
  expect(
    markdownReaders()
      .filter((reader) => reader.file.startsWith(".github/workflows/ci.yml:"))
      .map((reader) => reader.file),
  ).toEqual([
    ".github/workflows/ci.yml:ci-checks-policy:Documentation source policy rule",
    ".github/workflows/ci.yml:ci-checks-policy:Instruction references",
  ]);
}, 30_000);

test("an aliased filesystem reader with a typed path constant joins automatically", () => {
  repository((root, write) => {
    write(
      "scripts/aliased-reader.test.ts",
      'import { readFileSync as read } from "node:fs"; const INPUT: string = "README.md"; read(INPUT, "utf8");',
    );
    expect(markdownChecks({ root, changed: ["README.md"] })).toEqual([
      ["bun", "test", "scripts/aliased-reader.test.ts"],
    ]);
  });
});

test("static template paths join the same Markdown checks as quoted paths", () => {
  for (const expression of [
    "readFileSync(`README.md`, 'utf8');",
    "const INPUT = `README.md`; readFileSync(INPUT, 'utf8');",
    "const root = process.cwd(); readFileSync(path.join(root, `README.md`), 'utf8');",
    "const INPUT = `README.md`; Bun.file(INPUT);",
  ]) {
    repository((root, write) => {
      write(
        "scripts/template-reader.test.ts",
        `import { readFileSync } from "node:fs"; ${expression}`,
      );
      expect(markdownChecks({ root, changed: ["README.md"] })).toEqual([
        ["bun", "test", "scripts/template-reader.test.ts"],
      ]);
      expect(requiresPackageChecks({ root, changed: ["README.md"] })).toBe(
        false,
      );
    });
  }
});

test("quoted fixture declarations cannot shadow a real Markdown read", () => {
  repository((root, write) => {
    write(
      "scripts/shadowed-reader.test.ts",
      `import { readFileSync } from "node:fs";
const fixture = 'const INPUT = "external.md";';
// const INPUT = "comment.md";
const INPUT = "README.md";
readFileSync(INPUT, "utf8");`,
    );
    expect(markdownChecks({ root, changed: ["README.md"] })).toEqual([
      ["bun", "test", "scripts/shadowed-reader.test.ts"],
    ]);
    expect(
      markdownChecks({ root, changed: ["external.md", "comment.md"] }),
    ).toEqual([]);
  });
});

test("conflicting repeated path declarations fail closed in either order", () => {
  for (const definitions of [
    ["const root = mkdtempSync('fixture-');", "const root = process.cwd();"],
    ["const root = process.cwd();", "const root = mkdtempSync('fixture-');"],
  ]) {
    repository((root, write) => {
      write(
        "scripts/conflicting.test.ts",
        `import { readFileSync, mkdtempSync } from "node:fs";
function fixture() { ${definitions.at(0)} }
function repository() { ${definitions.at(1)} readFileSync(path.join(root, "README.md")); }`,
      );
      const errors = spyOn(console, "error").mockImplementation(() => {});
      try {
        expect(requiresPackageChecks({ root, changed: ["README.md"] })).toBe(
          true,
        );
        expect(String(errors.mock.calls.at(0)?.at(1))).toContain(
          "scripts/conflicting.test.ts",
        );
      } finally {
        errors.mockRestore();
      }
    });
  }
});

test("agreeing repeated declarations resolve independently", () => {
  repository((root, write) => {
    write(
      "scripts/agreeing.test.ts",
      `import { readFileSync } from "node:fs";
const INPUT = "README.md";
function first() { const file = INPUT; }
function second() { const file = INPUT; readFileSync(file); }`,
    );
    expect(markdownChecks({ root, changed: ["README.md"] })).toEqual([
      ["bun", "test", "scripts/agreeing.test.ts"],
    ]);
  });
});

test("named filesystem wrappers declare their real Markdown call inputs", () => {
  for (const body of [
    'return readFileSync(name, "utf8");',
    'if (name) { return readFileSync(name, "utf8"); } return "";',
  ]) {
    repository((root, write) => {
      write(
        "scripts/named-reader.test.ts",
        `import { readFileSync } from "node:fs";
function readDoc(name: string) { ${body} }
readDoc("README.md");`,
      );
      expect(markdownChecks({ root, changed: ["README.md"] })).toEqual([
        ["bun", "test", "scripts/named-reader.test.ts"],
      ]);
      expect(markdownChecks({ root, changed: ["external.md"] })).toEqual([]);
    });
  }
});

test("directory readers retain Markdown inputs at the root and outside docs", () => {
  for (const [expression, input] of [
    ['readdirSync("docs")', "docs/guide.md"],
    [
      'const root = process.cwd(); readdirSync(path.join(root, "docs"))',
      "docs/guide.md",
    ],
    ['readdirSync("prompts")', "prompts/instruction.md"],
    ['new Bun.Glob("prompts/**/*.md")', "prompts/nested/instruction.md"],
  ] as const) {
    repository((root, write) => {
      write(
        "scripts/directory-reader.test.ts",
        `import { readdirSync } from "node:fs"; ${expression};`,
      );
      expect(markdownChecks({ root, changed: [input] })).toEqual([
        ["bun", "test", "scripts/directory-reader.test.ts"],
      ]);
    });
  }
  repository((root, write) => {
    write(
      "apps/example/src/reader.ts",
      'import { readdirSync, readFileSync } from "node:fs"; for (const file of readdirSync("apps/example/prompts")) { readFileSync(path.join("apps/example/prompts", file)); }',
    );
    expect(
      requiresPackageChecks({
        root,
        changed: ["apps/example/prompts/instruction.md"],
      }),
    ).toBe(true);
  });
});

test("temporary factory inference rejects conflicting root declarations", () => {
  repository((root, write) => {
    write(
      "scripts/factory.test.ts",
      `import { readFileSync, mkdtempSync } from "node:fs";
function fixture() { const root = mkdtempSync("fixture-"); if (condition) { const root = process.cwd(); return root; } return root; }
const root = fixture(); readFileSync(path.join(root, "README.md"));`,
    );
    const errors = spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(requiresPackageChecks({ root, changed: ["README.md"] })).toBe(
        true,
      );
      expect(String(errors.mock.calls.at(0)?.at(1))).toContain(
        "scripts/factory.test.ts",
      );
    } finally {
      errors.mockRestore();
    }
  });
});

test("unresolved directory suffixes retain their known subtree and name the reader", () => {
  repository((root, write) => {
    write(
      "scripts/dynamic-directory.test.ts",
      'import { readdirSync } from "node:fs"; readdirSync(path.join("docs", directory));',
    );
    const errors = spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(requiresPackageChecks({ root, changed: ["docs/guide.md"] })).toBe(
        true,
      );
      expect(String(errors.mock.calls.at(0)?.at(1))).toContain(
        "scripts/dynamic-directory.test.ts",
      );
      expect(requiresPackageChecks({ root, changed: ["README.md"] })).toBe(
        false,
      );
    } finally {
      errors.mockRestore();
    }
  });
});

test("unresolved glob cwd remains named and fail-closed for Markdown and generic patterns", () => {
  for (const pattern of ["**/*.md", "**/*.{md,mdx}", "**/*", "**"]) {
    repository((root, write) => {
      const reader = "scripts/parameter-reader.test.ts";
      write(
        reader,
        `function scan(cwd: string) { return [...new Bun.Glob(${JSON.stringify(pattern)}).scanSync({ cwd: cwd })]; } scan(process.cwd());`,
      );
      const errors = spyOn(console, "error").mockImplementation(() => {});
      try {
        expect(requiresPackageChecks({ root, changed: ["README.md"] })).toBe(
          true,
        );
        expect(String(errors.mock.calls.at(0)?.at(1))).toContain(reader);
        expect(() => markdownChecks({ root, changed: ["README.md"] })).toThrow(
          "unresolved cwd",
        );
      } finally {
        errors.mockRestore();
      }
    });
  }
});

test("named unresolved scans derive their fail-closed subtree from their export inventory", () => {
  repository((root, write) => {
    const reader = "scripts/export-reader.test.ts";
    write(
      reader,
      `const PACKAGE = "packages/example";
const EXPORTED_PATHS = [PACKAGE, "scripts/helper.ts"];
export const CI_MARKDOWN_READER_INPUTS = EXPORTED_PATHS;
function scan(cwd: string) { return [...new Bun.Glob("**/*.{md,mdx}").scanSync({ cwd: cwd })]; }`,
    );
    expect(
      markdownReaders(root).find(({ file }) => file === reader)?.inputs,
    ).toEqual(["packages/example/**", "scripts/helper.ts"]);
    const errors = spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(
        requiresPackageChecks({
          root,
          changed: ["packages/example/README.md"],
        }),
      ).toBe(true);
      expect(String(errors.mock.calls.at(0)?.at(1))).toContain(reader);
      expect(requiresPackageChecks({ root, changed: ["README.md"] })).toBe(
        false,
      );
    } finally {
      errors.mockRestore();
    }
  });
});

test("declared parameterized scan inputs resolve joined roots and retain the real source pattern", () => {
  repository((root, write) => {
    write(
      "scripts/source-scan.ts",
      `const ROOT = process.cwd();
const APPS = path.join(ROOT, "apps");
const PATTERN = "**/*.{md,mdx,ts}";
export const CI_MARKDOWN_READER_INPUTS = [path.join(APPS, "*", "src", PATTERN)];
function scan(cwd: string) { return [...new Bun.Glob(PATTERN).scanSync({ cwd: cwd })]; }`,
    );
    expect(
      markdownReaders(root).find(
        ({ file }) => file === "scripts/source-scan.ts",
      )?.inputs,
    ).toEqual(["apps/*/src/**/*.{md,mdx,ts}"]);
    const errors = spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(
        requiresPackageChecks({
          root,
          changed: ["apps/example/src/content.md"],
        }),
      ).toBe(true);
      expect(
        requiresPackageChecks({ root, changed: ["apps/example/README.md"] }),
      ).toBe(false);
    } finally {
      errors.mockRestore();
    }
  });
});

test("empty and computed scan declarations cannot certify an unknown cwd", () => {
  for (const expression of [
    "[]",
    "computedInputs()",
    "[unknownRoot]",
    '["docs" + suffix]',
  ]) {
    repository((root, write) => {
      write(
        "scripts/invalid-scan.ts",
        `export const CI_MARKDOWN_READER_INPUTS = ${expression}; function scan(cwd: string) { return new Bun.Glob("**/*.{md,mdx}").scanSync({cwd: cwd}); }`,
      );
      const errors = spyOn(console, "error").mockImplementation(() => {});
      try {
        expect(requiresPackageChecks({ root, changed: ["README.md"] })).toBe(
          true,
        );
        expect(String(errors.mock.calls.at(0)?.at(1))).toContain(
          "scripts/invalid-scan.ts",
        );
      } finally {
        errors.mockRestore();
      }
    });
  }
});

test("glob scans resolve cwd aliases through file URLs", () => {
  repository((root, write) => {
    write(
      "apps/example/scripts/reader.ts",
      `import { fileURLToPath } from "node:url";
const ROOT_URL = new URL("../", import.meta.url);
const ROOT_PATH = fileURLToPath(ROOT_URL);
new Bun.Glob("**/*.md").scanSync({ cwd: ROOT_PATH });`,
    );
    expect(
      requiresPackageChecks({ root, changed: ["apps/example/README.md"] }),
    ).toBe(true);
    expect(markdownChecks({ root, changed: ["README.md"] })).toEqual([]);
  });
});

test("exported source censuses preserve gitlink ownership boundaries", () => {
  repository((root, write) => {
    write(
      ".gitmodules",
      '[submodule "packages/example/content"]\n path = packages/example/content\n url = https://example.invalid/content.git\n',
    );
    write(
      "packages/example/content/convert.ts",
      'import { readFileSync } from "node:fs"; readFileSync(join(EXTERNAL_ROOT, directory, "template.md"));',
    );
    write(
      "scripts/real.test.ts",
      'import { readFileSync } from "node:fs"; readFileSync("README.md");',
    );
    expect(markdownChecks({ root, changed: ["README.md"] })).toEqual([
      ["bun", "test", "scripts/real.test.ts"],
    ]);
  });
});

test("a reader without an isolated command fails closed and names its owner", () => {
  repository((root, write) => {
    write(
      "scripts/undeclared-reader.ts",
      'const text = Bun.file("README.md");',
    );
    const errors = spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(requiresPackageChecks({ root, changed: ["README.md"] })).toBe(
        true,
      );
      expect(String(errors.mock.calls.at(0)?.at(1))).toContain(
        "scripts/undeclared-reader.ts",
      );
    } finally {
      errors.mockRestore();
    }
  });
});

test("fixture literals and external Markdown names do not declare readers", () => {
  repository((root, write) => {
    write(
      "scripts/fixture.test.ts",
      'import { readFileSync } from "node:fs"; const fixture = "README.md"; const source = readFileSync("package.json", "utf8");',
    );
    expect(markdownChecks({ root, changed: ["README.md"] })).toEqual([]);
    expect(requiresPackageChecks({ root, changed: ["README.md"] })).toBe(false);
  });
});

test("Markdown reads under a temporary fixture root are not repository readers", () => {
  repository((root, write) => {
    write(
      "scripts/temporary.test.ts",
      'import { readFileSync, mkdtempSync } from "node:fs"; import { tmpdir } from "node:os"; const root = mkdtempSync(path.join(tmpdir(), "fixture-")); readFileSync(path.join(root, "README.md"));',
    );
    expect(markdownChecks({ root, changed: ["README.md"] })).toEqual([]);
  });
});

test("an unresolved Markdown path names its owner and retains package checks", () => {
  repository((root, write) => {
    write(
      "scripts/computed-reader.test.ts",
      'import { readFileSync } from "node:fs"; readFileSync(path.join(root, name(), ".md"));',
    );
    const errors = spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(requiresPackageChecks({ root, changed: ["README.md"] })).toBe(
        true,
      );
      expect(String(errors.mock.calls.at(0)?.at(1))).toContain(
        "scripts/computed-reader.test.ts",
      );
    } finally {
      errors.mockRestore();
    }
  });
});

test("a planted transitive dependency triggers landing while unrelated packages do not", () => {
  repository((root) => {
    for (const file of [
      "apps/landing/src/page.astro",
      "packages/ui/src/view.tsx",
      "packages/base/src/base.ts",
      "docs/changelog/change.md",
      "scripts/media.ts",
    ]) {
      expect(requiresLandingBuild({ root, changed: [file] }), file).toBe(true);
    }
    for (const changed of [
      [],
      ["apps/web/src/page.tsx"],
      ["packages/unrelated/src/code.ts"],
      ["docs/guide.md"],
    ]) {
      expect(requiresLandingBuild({ root, changed })).toBe(false);
    }
  });
});

test("every global scope runs package checks and landing regardless of graph metadata", () => {
  repository((root) => {
    for (const file of [
      "bun.lock",
      "apps/example/package.json",
      "packages/example/tsconfig.build.json",
      "turbo.json",
      "patches/example.patch",
      ".github/actions/test.md",
      "bunfig.toml",
      ".npmrc",
    ]) {
      expect(requiresPackageChecks({ root, changed: [file] }), file).toBe(true);
      expect(requiresLandingBuild({ root, changed: [file] }), file).toBe(true);
    }
    expect(
      requiresLandingBuild({
        root,
        changed: ["packages/unrelated/unknown.weird"],
      }),
    ).toBe(true);
  });
});

test("malformed or missing metadata fails closed for both selectors", () => {
  repository((root, write) => {
    write("turbo.json", "invalid json");
    expect(requiresPackageChecks({ root, changed: ["docs/guide.md"] })).toBe(
      true,
    );
    expect(
      requiresLandingBuild({ root, changed: ["apps/web/src/page.tsx"] }),
    ).toBe(true);
    write("turbo.json", '{"tasks":{}}');
    expect(
      requiresLandingBuild({ root, changed: ["apps/web/src/page.tsx"] }),
    ).toBe(true);
    write("bun.lock", '{"workspaces":{},"packages":{}}');
    expect(
      requiresLandingBuild({ root, changed: ["apps/web/src/page.tsx"] }),
    ).toBe(true);
  });
  expect(
    requiresPackageChecks({
      root: "/missing-checkout",
      changed: ["docs/guide.md"],
    }),
  ).toBe(true);
  expect(
    requiresLandingBuild({
      root: "/missing-checkout",
      changed: ["apps/web/src/page.tsx"],
    }),
  ).toBe(true);
});

test("split path joins and indirect directory readers retain their markdown subtrees", () => {
  repository((root, write) => {
    expect(
      requiresPackageChecks({ root, changed: ["docs/contracts/planted.md"] }),
    ).toBe(false);
    write(
      "scripts/join.test.ts",
      'import { readFileSync } from "node:fs"; const root = process.cwd(); const source = readFileSync(path.join(root, "docs/contracts", "planted.md"));',
    );
    expect(
      markdownChecks({ root, changed: ["docs/contracts/planted.md"] }),
    ).toEqual([["bun", "test", "scripts/join.test.ts"]]);
    write(
      "scripts/dir.test.ts",
      'import { readdirSync } from "node:fs"; const directory = "docs/records"; readdirSync(directory);',
    );
    expect(markdownChecks({ root, changed: ["docs/records/new.md"] })).toEqual([
      ["bun", "test", "scripts/dir.test.ts"],
    ]);
    expect(requiresPackageChecks({ root, changed: ["docs/unread.md"] })).toBe(
      false,
    );
  });
});

test("direct markdown imports retain package checks", () => {
  repository((root, write) => {
    expect(requiresPackageChecks({ root, changed: ["docs/imported.md"] })).toBe(
      false,
    );
    write(
      "scripts/import-reader.ts",
      'import text from "../docs/imported.md" with { type: "text" };',
    );
    expect(requiresPackageChecks({ root, changed: ["docs/imported.md"] })).toBe(
      true,
    );
  });
});

test("a Markdown fixture imported as module content retains package jobs", () => {
  repository((root, write) => {
    write(
      "apps/example/src/reader.ts",
      'import text from "./fixtures/input.md" with { type: "text" };',
    );
    expect(
      requiresPackageChecks({
        root,
        changed: ["apps/example/src/fixtures/input.md"],
      }),
    ).toBe(true);
    expect(
      requiresPackageChecks({ root, changed: ["apps/example/README.md"] }),
    ).toBe(false);
  });
});

test("content loader globs use their declared workspace base", () => {
  repository((root, write) => {
    write(
      "apps/example/src/content.config.ts",
      'import { glob } from "astro/loaders"; glob({ pattern: "**/*.md", base: "./src/content/blog" });',
    );
    expect(
      requiresPackageChecks({
        root,
        changed: ["notes/unconsumed.md", ".changeset/unconsumed.md"],
      }),
    ).toBe(false);
    expect(
      requiresPackageChecks({
        root,
        changed: ["apps/example/src/content/blog/new.md"],
      }),
    ).toBe(true);
  });
});

test("repository readers preserve consumed documentation without swallowing unrelated markdown", () => {
  const unconsumed = path.posix.join(
    "notes",
    `${["scope", "smoke"].join("-")}.md`,
  );
  expect(requiresPackageChecks({ changed: [unconsumed] })).toBe(false);
  expect(markdownChecks({ changed: [unconsumed] })).toContainEqual([
    "bun",
    "test",
    "scripts/capability-catalog-readers.test.ts",
  ]);
  expect(markdownChecks({ changed: ["docs/guide.md"] })).toContainEqual([
    "bun",
    "test",
    "scripts/capability-catalog-readers.test.ts",
  ]);
}, 30_000);

test("loader wildcard bases stay tied to their calls", () => {
  repository((root, write) => {
    write(
      "scripts/content.ts",
      'import { glob } from "astro/loaders"; glob({ pattern: "**/*.md", base: "notes/consumed" }); const other = { base: "elsewhere" };',
    );
    expect(
      requiresPackageChecks({ root, changed: ["notes/consumed/new.md"] }),
    ).toBe(true);
    expect(
      requiresPackageChecks({ root, changed: ["notes/unconsumed/new.md"] }),
    ).toBe(false);
    write(
      "scripts/content.ts",
      'import { glob } from "astro/loaders"; glob({ pattern: "**/*.md", base: "notes/consumed" }); glob({ pattern: "**/*.md" });',
    );
    expect(
      requiresPackageChecks({ root, changed: ["notes/unconsumed/new.md"] }),
    ).toBe(true);
  });
});

test("an unknown Astro glob identifies the reader whose declaration needs repair", () => {
  repository((root, write) => {
    const reader = "scripts/unknown-content-reader.ts";
    write(
      reader,
      'import { glob } from "astro/loaders"; glob({ pattern: getPattern(), base: "notes/consumed" });',
    );
    const diagnostic = spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(
        requiresPackageChecks({ root, changed: ["notes/unread.md"] }),
      ).toBe(true);
      expect(diagnostic).toHaveBeenCalledWith(
        "Package scope unavailable; running package checks",
        expect.objectContaining({
          name: "MarkdownReaderDeclarationError",
          message: `${reader}: Astro glob must declare a literal Markdown pattern and base`,
        }),
      );
    } finally {
      diagnostic.mockRestore();
    }
  });
});

test("scope selectors run before dependency installation", () => {
  expect(
    importProblems({
      root: path.resolve(import.meta.dir, ".."),
      entries: ["scripts/ci-package-scope.ts"],
    }),
  ).toEqual([]);
});

test("loader option expressions retain the broad pattern", () => {
  repository((root, write) => {
    for (const options of [
      '{ base: "notes/consumed", pattern: "**/*.md" }',
      '{ pattern: "**/*.md", base: "notes/consumed", ...overrides }',
      '{ pattern: "**/*.md", base: getBase("notes/consumed") }',
      '{ pattern: "**/*.md", base: "notes/consumed" }, extra',
    ]) {
      write(
        "scripts/content.ts",
        `import { glob } from "astro/loaders"; glob(${options});`,
      );
      expect(
        requiresPackageChecks({ root, changed: ["notes/consumed/new.md"] }),
      ).toBe(true);
      expect(
        requiresPackageChecks({ root, changed: ["notes/unconsumed/new.md"] }),
      ).toBe(!options.startsWith("{ base:"));
    }
  });
});

test("dynamic and aliased content loaders retain Markdown checks", () => {
  repository((root, write) => {
    for (const source of [
      `import { glob } from "astro/loaders"; glob({ pattern: \`\${prefix}/*.md\`, base: "notes/consumed" });`,
      'import { glob as load } from "astro/loaders"; load({ pattern: "**/*.md", base: "notes/consumed" });',
    ]) {
      write("scripts/content.ts", source);
      expect(requiresPackageChecks({ root, changed: ["notes/new.md"] })).toBe(
        true,
      );
    }
    write(
      "turbo.json",
      JSON.stringify({ tasks: { "@stll/example#test": { inputs: [42] } } }),
    );
    expect(requiresPackageChecks({ root, changed: ["notes/new.md"] })).toBe(
      true,
    );
  });
});

test("fixture source containing content loader text does not declare a loader import", () => {
  repository((root, write) => {
    write(
      "scripts/fixture.test.ts",
      `import { readFileSync } from "node:fs"; const source = 'import { glob } from "astro/loaders"; glob({ pattern: "**/*.md" });';`,
    );
    expect(requiresPackageChecks({ root, changed: ["notes/new.md"] })).toBe(
      false,
    );
  });
});

test("loader patterns with directory prefixes resolve under their declared base", () => {
  repository((root, write) => {
    for (const pattern of [
      "articles/**/*.md",
      "articles/**/*.{md,mdx}",
      "articles/**",
    ]) {
      write(
        "scripts/content.ts",
        `import {glob} from "astro/loaders"; glob({pattern:"${pattern}",base:"notes/consumed"});`,
      );
      expect(
        requiresPackageChecks({
          root,
          changed: ["notes/consumed/articles/new.md"],
        }),
      ).toBe(true);
      expect(
        requiresPackageChecks({ root, changed: ["articles/new.md"] }),
      ).toBe(false);
    }
  });
});

test("unrelated Markdown options cannot certify a computed loader pattern", () => {
  repository((root, write) => {
    write(
      "scripts/content.ts",
      `import {glob} from "astro/loaders"; glob({pattern:\`\${prefix}/*.md\`,base:"notes/consumed",ignore:"README.md"});`,
    );
    expect(
      requiresPackageChecks({ root, changed: ["notes/consumed/new.md"] }),
    ).toBe(true);
  });
});
