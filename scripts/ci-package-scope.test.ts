import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  requiresDesktopBrowser,
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
      "packages/example/README.md",
      "apps/api/src/prompt.md",
      "apps/landing/src/content/guide.mdx",
      "railway/template-readme.md",
      "docs/unrecognized.weird",
      "scripts/fixtures/dependency-malware/README.md",
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

test("a planted markdown reader prevents skipping its checks, including deleted input files", () => {
  repository((root, write) => {
    expect(requiresPackageChecks({ root, changed: ["docs/planted.md"] })).toBe(
      false,
    );
    write(
      "scripts/reader.test.ts",
      'import { readFileSync } from "node:fs"; const source = readFileSync("../docs/planted.md", "utf8");',
    );
    expect(requiresPackageChecks({ root, changed: ["docs/planted.md"] })).toBe(
      true,
    );
    expect(requiresPackageChecks({ root, changed: ["docs/unread.md"] })).toBe(
      false,
    );
    write("scripts/readme.test.ts", 'const source = Bun.file("README.md");');
    expect(requiresPackageChecks({ root, changed: ["README.md"] })).toBe(true);
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
      'import { readFileSync } from "node:fs"; const source = readFileSync(path.join(root, "docs/contracts", "planted.md"));',
    );
    expect(
      requiresPackageChecks({ root, changed: ["docs/contracts/planted.md"] }),
    ).toBe(true);
    write(
      "scripts/dir.test.ts",
      'import { readdirSync } from "node:fs"; const directory = "docs/records"; readdirSync(directory);',
    );
    expect(
      requiresPackageChecks({ root, changed: ["docs/records/new.md"] }),
    ).toBe(true);
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
  expect(
    requiresPackageChecks({
      changed: ["scripts/fixtures/dependency-malware/README.md"],
    }),
  ).toBe(true);
  expect(requiresPackageChecks({ changed: ["docs/guide.md"] })).toBe(true);
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
    write(
      "scripts/content.ts",
      'import {glob} from "astro/loaders"; glob({pattern:"articles/**/*.md",base:"notes/consumed"});',
    );
    expect(
      requiresPackageChecks({
        root,
        changed: ["notes/consumed/articles/new.md"],
      }),
    ).toBe(true);
    expect(requiresPackageChecks({ root, changed: ["articles/new.md"] })).toBe(
      false,
    );
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

const desktopLock = () => ({
  workspaces: {
    "apps/desktop": {
      name: "@stll/desktop",
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
});
const desktopRepository = (
  run: (root: string, write: (file: string, text: string) => void) => void,
) =>
  repository((root, write) => {
    write("bun.lock", JSON.stringify(desktopLock()));
    write(
      "turbo.json",
      JSON.stringify({
        tasks: {
          "@stll/desktop#test:browser": {
            inputs: ["$TURBO_DEFAULT$", "$TURBO_ROOT$/fixtures/browser/**"],
          },
        },
      }),
    );
    run(root, write);
  });

test("desktop browser scope follows transitive workspace dependencies, declared browser inputs and global inputs", () => {
  desktopRepository((root) => {
    for (const file of [
      "apps/desktop/src/new.unknown",
      "apps/desktop/tests/browser/new.playwright.spec.ts",
      "packages/ui/src/new.ts",
      "packages/base/src/transitive.ts",
      "fixtures/browser/deleted.html",
      ".github/workflows/ci.yml",
      "bun.lock",
      "package.json",
      "patches/new.patch",
    ]) {
      expect(requiresDesktopBrowser({ root, changed: [file] }), file).toBe(
        true,
      );
    }
    for (const changed of [
      [],
      ["docs/guide.md"],
      ["apps/web/src/unrelated.ts"],
      ["packages/unrelated/src/new.ts"],
    ]) {
      expect(
        requiresDesktopBrowser({ root, changed }),
        JSON.stringify(changed),
      ).toBe(false);
    }
  });
});

test("a planted unclassified desktop file selects desktop browsers without changing the selector", () => {
  desktopRepository((root, write) => {
    expect(requiresDesktopBrowser({ root, changed: ["docs/guide.md"] })).toBe(
      false,
    );
    const planted = "apps/desktop/new-subsystem/planted.unclassified";
    write(planted, "new desktop input");
    expect(requiresDesktopBrowser({ root, changed: [planted] })).toBe(true);
  });
});

test("desktop browser scope fails closed on missing or malformed graph and input declarations", () => {
  for (const [file, contents] of [
    ["bun.lock", "{"],
    ["bun.lock", JSON.stringify({ workspaces: {}, packages: {} })],
    ["turbo.json", JSON.stringify({ tasks: {} })],
    [
      "turbo.json",
      JSON.stringify({
        tasks: { "@stll/desktop#test:browser": { inputs: [4] } },
      }),
    ],
  ]) {
    desktopRepository((root, write) => {
      expect(requiresDesktopBrowser({ root, changed: ["docs/guide.md"] })).toBe(
        false,
      );
      if (file === undefined || contents === undefined) {
        throw new TypeError("Missing desktop scope mutation");
      }
      write(file, contents);
      expect(requiresDesktopBrowser({ root, changed: ["docs/guide.md"] })).toBe(
        true,
      );
    });
  }
  desktopRepository((root, write) => {
    const lock = desktopLock();
    const { "@stll/base": removed, ...packages } = lock.packages;
    expect(removed).toBeDefined();
    write("bun.lock", JSON.stringify({ ...lock, packages }));
    expect(requiresDesktopBrowser({ root, changed: ["docs/guide.md"] })).toBe(
      true,
    );
  });
});
