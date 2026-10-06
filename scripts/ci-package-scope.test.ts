import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  requiresLandingBuild,
  requiresPackageChecks,
} from "./ci-package-scope";

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
});

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
