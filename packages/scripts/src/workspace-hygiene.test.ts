import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { validateWorkspaceRoot } from "./workspace-hygiene";

let tempRoots: string[] = [];

afterEach(() => {
  for (const tempRoot of tempRoots) {
    rmSync(tempRoot, { force: true, recursive: true });
  }

  tempRoots = [];
});

describe("workspace hygiene", () => {
  test("requires CSS package imports to be owned by the importing workspace", () => {
    const rootDir = createWorkspaceRoot({
      webPackageJson: {
        dependencies: {},
        name: "@stll/web",
      },
    });

    writeFileSync(
      path.join(rootDir, "apps/web/src/reader.css"),
      '@import "@fontsource-variable/source-serif-4";\n',
    );

    expect(validateWorkspaceRoot(rootDir)).toEqual([
      {
        message:
          "CSS import @fontsource-variable/source-serif-4 resolves to package @fontsource-variable/source-serif-4, but @fontsource-variable/source-serif-4 is not declared in this workspace package.json",
        path: "apps/web/src/reader.css:1",
      },
    ]);
  });

  test("accepts CSS package imports declared by the importing workspace", () => {
    const rootDir = createWorkspaceRoot({
      webPackageJson: {
        dependencies: {
          "@fontsource-variable/source-serif-4": "^5.2.9",
        },
        name: "@stll/web",
      },
    });

    writeFileSync(
      path.join(rootDir, "apps/web/src/reader.css"),
      '@import "@fontsource-variable/source-serif-4";\n',
    );

    expect(validateWorkspaceRoot(rootDir)).toEqual([]);
  });

  test("ignores package imports inside CSS comments", () => {
    const rootDir = createWorkspaceRoot({
      webPackageJson: {
        dependencies: {},
        name: "@stll/web",
      },
    });

    writeFileSync(
      path.join(rootDir, "apps/web/src/reader.css"),
      '/*\n@import "@fontsource-variable/source-serif-4";\n*/\n',
    );

    expect(validateWorkspaceRoot(rootDir)).toEqual([]);
  });
});

type CreateWorkspaceRootOptions = {
  webPackageJson: Record<string, unknown>;
};

const createWorkspaceRoot = ({
  webPackageJson,
}: CreateWorkspaceRootOptions) => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "stella-workspace-hygiene-"));
  tempRoots.push(rootDir);

  mkdirSync(path.join(rootDir, "apps/web/src"), { recursive: true });
  mkdirSync(path.join(rootDir, "packages"), { recursive: true });
  writeFileSync(
    path.join(rootDir, "apps/web/package.json"),
    JSON.stringify(webPackageJson),
  );

  return rootDir;
};
