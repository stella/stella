import { describe, expect, test } from "bun:test";
import path from "node:path";

import {
  collectGithubTargets,
  readPinnedSnapshot,
  syntheticSkillSource,
} from "@stll/catalogue/pinned-facts";
import {
  isAllowedFirstPartySkillPackageSkip,
  validateSkillPackage,
} from "@stll/skills";

import { skillRequirableToolNames } from "./required-tools-validation";

const root = path.resolve(import.meta.dir, "../../../../..");
const PACKAGE_FILE_GLOB = ["**", "/*"].join("");

const readPackages = async (packageRoot: string) => {
  const filesByPackage = new Map<string, { content: string; path: string }[]>();
  const glob = new Bun.Glob(PACKAGE_FILE_GLOB);
  for await (const relativePath of glob.scan({
    cwd: packageRoot,
    onlyFiles: true,
  })) {
    const packageName = relativePath.split("/").at(0);
    if (packageName === undefined) {
      continue;
    }
    const files = filesByPackage.get(packageName) ?? [];
    files.push({
      content: await Bun.file(path.join(packageRoot, relativePath)).text(),
      path: relativePath.slice(packageName.length + 1),
    });
    filesByPackage.set(packageName, files);
  }
  return filesByPackage;
};

const expectValid = (files: readonly { content: string; path: string }[]) => {
  const result = validateSkillPackage({
    files,
    tools: { known: skillRequirableToolNames(), type: "check" },
  });
  expect(result.isOk()).toBe(true);
  if (result.isOk()) {
    expect(
      result.value.skipped.filter(
        (skipped) => !isAllowedFirstPartySkillPackageSkip(skipped),
      ),
    ).toEqual([]);
  }
};

describe("first-party skill packages", () => {
  test("every built-in skill and blueprint satisfies the host format", async () => {
    const packageRoots = [
      path.join(root, "packages/skills/skills"),
      path.join(root, "packages/skills/blueprints"),
    ];
    for (const packageRoot of packageRoots) {
      const packages = await readPackages(packageRoot);
      expect(packages.size).toBeGreaterThan(0);
      for (const files of packages.values()) {
        expectValid(files);
      }
    }
  });

  test("allows root ancillary files and rejects nested skipped files", () => {
    expectValid([
      {
        path: "SKILL.md",
        content:
          "---\nname: ancillary\ndescription: Ancillary\n---\nInstructions",
      },
      { path: "README.md", content: "Notes" },
    ]);

    const result = validateSkillPackage({
      files: [
        {
          path: "SKILL.md",
          content: "---\nname: nested\ndescription: Nested\n---\nInstructions",
        },
        { path: "notes/README.md", content: "Stray notes" },
      ],
      tools: { known: skillRequirableToolNames(), type: "check" },
    });
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(
        result.value.skipped.every(isAllowedFirstPartySkillPackageSkip),
      ).toBe(false);
    }
  });

  test("every pinned catalogue skill records a matching valid package", async () => {
    const snapshot = await readPinnedSnapshot(collectGithubTargets());
    expect(snapshot.entries.length).toBeGreaterThan(0);
    for (const entry of snapshot.entries) {
      const prefix = entry.target.directory ? `${entry.target.directory}/` : "";
      const files = [
        {
          path: "SKILL.md",
          content: syntheticSkillSource(
            entry.skill.frontmatter,
            entry.skill.bodyUtf16Length,
            entry.skill.referencedResourcePaths,
          ),
        },
        ...entry.resources.map((resource) => ({
          content: "x".repeat(resource.utf16Length),
          path: resource.path.startsWith(prefix)
            ? resource.path.slice(prefix.length)
            : resource.path,
        })),
      ];
      expectValid(files);
      expect(entry.target.slug).toBe(entry.skill.frontmatter.name);
    }
  });

  test("checks required tools reconstructed from pinned facts", async () => {
    const snapshot = await readPinnedSnapshot(collectGithubTargets());
    const entry = snapshot.entries.at(0);
    expect(entry).toBeDefined();
    if (!entry) {
      return;
    }
    const source = syntheticSkillSource(
      {
        ...entry.skill.frontmatter,
        metadata: [
          {
            key: "stella-required-tools",
            type: "stella",
            value: "not-a-tool",
          },
        ],
      },
      entry.skill.bodyUtf16Length,
      entry.skill.referencedResourcePaths,
    );
    const result = validateSkillPackage({
      files: [{ content: source, path: "SKILL.md" }],
      tools: { known: skillRequirableToolNames(), type: "check" },
    });
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.map(({ type }) => type)).toContain(
        "required_tool_unknown",
      );
    }
  });

  test.each([
    {
      expected: "required_tool_unknown",
      files: [
        {
          path: "SKILL.md",
          content:
            "---\nname: invalid-tool\ndescription: Invalid tool\nmetadata:\n  stella-required-tools: not-a-tool\n---\nInstructions",
        },
      ],
    },
    {
      expected: "resource_reference_missing",
      files: [
        {
          path: "SKILL.md",
          content:
            "---\nname: missing-resource\ndescription: Missing resource\n---\nRead `references/missing.md`.",
        },
      ],
    },
    {
      expected: "metadata_key_unknown",
      files: [
        {
          path: "SKILL.md",
          content:
            "---\nname: unknown-metadata\ndescription: Unknown metadata\nmetadata:\n  stella-unknown: value\n---\nInstructions",
        },
      ],
    },
  ])("rejects $expected", ({ expected, files }) => {
    const result = validateSkillPackage({
      files,
      tools: { known: skillRequirableToolNames(), type: "check" },
    });
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.map(({ type }) => type)).toContain(expected);
    }
  });
});
