import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import nodePath from "node:path";

import { SKILL_PACKAGE_LIMITS } from "./format";
import {
  buildSkillPackage,
  isZipArchiveBytes,
  readSkillPackage,
  SKILL_PACKAGE_FILE_TYPES,
  SKILL_PACKAGE_FORMATS,
  SKILL_PACKAGE_MANIFEST_PATH,
  type SkillArchiveEntry,
  type SkillPackageSource,
} from "./package";

const encoder = new TextEncoder();

const SKILL_MD = [
  "---",
  'name: "contract-review"',
  'description: "Review a contract against the checklist."',
  "---",
  "",
  "Read `references/checklist.md` first.",
  "",
].join("\n");

const source = (
  overrides: Partial<SkillPackageSource> = {},
): SkillPackageSource => ({
  command: "review",
  displayName: "Contract review",
  resources: [
    { bytes: encoder.encode("- parties\n"), path: "references/checklist.md" },
    {
      bytes: Uint8Array.from([0x25, 0x50, 0x44, 0x46, 0x00, 0xff]),
      path: "assets/template.pdf",
    },
  ],
  skillMd: SKILL_MD,
  slug: "contract-review",
  ...overrides,
});

const replace = (
  entries: readonly SkillArchiveEntry[],
  path: string,
  bytes: Uint8Array,
): SkillArchiveEntry[] =>
  entries.map((entry) => (entry.path === path ? { bytes, path } : entry));

const manifestOf = (entries: readonly SkillArchiveEntry[]) => {
  const manifest = entries.find(({ path }) =>
    path.endsWith(SKILL_PACKAGE_MANIFEST_PATH),
  );
  if (manifest === undefined) {
    throw new TypeError("expected a manifest entry");
  }
  return manifest;
};

const withManifest = (
  entries: readonly SkillArchiveEntry[],
  edit: (manifest: Record<string, unknown>) => unknown,
): SkillArchiveEntry[] => {
  const { bytes, path } = manifestOf(entries);
  const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
  if (typeof parsed !== "object" || parsed === null) {
    throw new TypeError("expected a manifest object");
  }
  return replace(
    entries,
    path,
    encoder.encode(
      JSON.stringify(edit(Object.fromEntries(Object.entries(parsed)))),
    ),
  );
};

describe("skill package", () => {
  test("lays the skill out in one folder named after its slug", () => {
    expect(buildSkillPackage(source()).map(({ path }) => path)).toEqual([
      "contract-review/SKILL.md",
      "contract-review/assets/template.pdf",
      "contract-review/references/checklist.md",
      `contract-review/${SKILL_PACKAGE_MANIFEST_PATH}`,
    ]);
  });

  test("reads back the same SKILL.md, files, display name and command", () => {
    const read = readSkillPackage(buildSkillPackage(source()));

    expect(read.isOk()).toBe(true);
    const value = read.unwrap();
    expect(value.skillMd).toBe(SKILL_MD);
    expect(value.resources).toEqual(
      source().resources.toSorted((left, right) =>
        left.path < right.path ? -1 : 1,
      ),
    );
    expect(value.manifest?.skill).toEqual({
      command: "review",
      displayName: "Contract review",
      slug: "contract-review",
    });
  });

  test("a skill without a command round-trips without one", () => {
    const read = readSkillPackage(
      buildSkillPackage(source({ command: null })),
    ).unwrap();

    expect(read.manifest?.skill.command).toBeNull();
  });

  test("a folder without a manifest reads as a plain skill folder", () => {
    const entries = buildSkillPackage(source()).filter(
      ({ path }) => !path.endsWith(SKILL_PACKAGE_MANIFEST_PATH),
    );
    const read = readSkillPackage(entries).unwrap();

    expect(read.manifest).toBeNull();
    expect(read.resources.map(({ path }) => path)).toEqual([
      "assets/template.pdf",
      "references/checklist.md",
    ]);
  });

  test("files in the reserved folder never become files of the skill", () => {
    const built = buildSkillPackage(
      source({
        resources: [
          { bytes: encoder.encode("x"), path: ".stella/notes.md" },
          { bytes: encoder.encode("y"), path: ".STELLA/other.md" },
        ],
      }),
    );
    const read = readSkillPackage([
      ...built,
      { bytes: encoder.encode("z"), path: "contract-review/.stella/extra.md" },
    ]).unwrap();

    expect(built.map(({ path }) => path)).toEqual([
      "contract-review/SKILL.md",
      `contract-review/${SKILL_PACKAGE_MANIFEST_PATH}`,
    ]);
    expect(read.resources).toEqual([]);
  });

  test("a file changed after export is refused", () => {
    const built = buildSkillPackage(source());
    const changed = replace(
      built,
      "contract-review/references/checklist.md",
      encoder.encode("- parties, edited\n"),
    );

    expect(readSkillPackage(changed).isErr()).toBe(true);
    expect(readSkillPackage(changed)).toMatchObject({
      error: { path: "references/checklist.md", type: "file_changed" },
    });
  });

  test("a listed file that is missing is refused", () => {
    const missing = buildSkillPackage(source()).filter(
      ({ path }) => path !== "contract-review/assets/template.pdf",
    );

    expect(readSkillPackage(missing)).toMatchObject({
      error: { path: "assets/template.pdf", type: "file_missing" },
    });
  });

  test("a manifest of a newer format is refused, not read as this one", () => {
    const newer = withManifest(buildSkillPackage(source()), (manifest) => ({
      ...manifest,
      formatVersion: 2,
    }));

    expect(readSkillPackage(newer)).toMatchObject({
      error: { formatVersion: 2, type: "format_version_unsupported" },
    });
  });

  test.each([
    ["not JSON", () => encoder.encode("{")],
    [
      "without a version",
      () => encoder.encode(JSON.stringify({ files: [], skill: {} })),
    ],
  ] as const)("a manifest %s is refused", (_, bytes) => {
    const built = buildSkillPackage(source());
    const broken = replace(built, manifestOf(built).path, bytes());

    expect(readSkillPackage(broken)).toMatchObject({
      error: { type: "manifest_invalid" },
    });
  });

  test.each([
    ["a slug that is no skill name", { slug: "Not A Slug" }],
    ["an empty display name", { displayName: " " }],
    ["a display name over 64 characters", { displayName: "x".repeat(65) }],
    ["a command that is not text", { command: 7 }],
  ] as const)("a manifest with %s is refused", (_, skill) => {
    const broken = withManifest(buildSkillPackage(source()), (manifest) => ({
      ...manifest,
      skill: { command: null, displayName: "A", slug: "a", ...skill },
    }));

    expect(readSkillPackage(broken)).toMatchObject({
      error: { type: "manifest_invalid" },
    });
  });

  test("a package at the archive size limit reads back whole", () => {
    // SKILL.md and the manifest take their share of the limit too.
    const manifestShare = 64 * 1024;
    const chunk = SKILL_PACKAGE_LIMITS.resourceMaxChars;
    const total =
      SKILL_PACKAGE_LIMITS.archiveUncompressedMaxBytes -
      encoder.encode(SKILL_MD).byteLength -
      manifestShare;
    const resources: SkillArchiveEntry[] = [];
    for (let offset = 0; offset < total; offset += chunk) {
      const size = Math.min(chunk, total - offset);
      resources.push({
        bytes: new Uint8Array(size).fill(0x61),
        path: `references/part-${String(resources.length).padStart(3, "0")}.md`,
      });
    }
    const built = buildSkillPackage(source({ resources }));
    const archiveBytes = built.reduce(
      (sum, { bytes }) => sum + bytes.byteLength,
      0,
    );
    const read = readSkillPackage(built).unwrap();

    expect(archiveBytes).toBeLessThanOrEqual(
      SKILL_PACKAGE_LIMITS.archiveUncompressedMaxBytes,
    );
    expect(archiveBytes).toBeGreaterThan(
      SKILL_PACKAGE_LIMITS.archiveUncompressedMaxBytes - manifestShare,
    );
    expect(read.resources.length).toBe(resources.length);
    expect(
      read.resources.reduce((sum, { bytes }) => sum + bytes.byteLength, 0),
    ).toBe(total);
  });

  test("api-contract offers the same package file extensions to browsers", () => {
    // @stll/api-contract cannot import this package, so it carries a copy.
    const contract = readFileSync(
      nodePath.join(import.meta.dir, "../../api-contract/src/agent-skills.ts"),
      "utf-8",
    );
    const copy =
      /export const SKILL_PACKAGE_FILE_EXTENSIONS = \[(.+)\] as const;/u.exec(
        contract,
      )?.[1];

    expect(copy).toBe(
      SKILL_PACKAGE_FORMATS.map(
        (format) => `".${SKILL_PACKAGE_FILE_TYPES[format].extension}"`,
      ).join(", "),
    );
  });

  test("a zip is recognized by its bytes, not by a name", () => {
    expect(isZipArchiveBytes(Uint8Array.from([0x50, 0x4b, 0x03, 0x04]))).toBe(
      true,
    );
    expect(isZipArchiveBytes(Uint8Array.from([0x50, 0x4b, 0x05, 0x06]))).toBe(
      true,
    );
    expect(isZipArchiveBytes(encoder.encode("---\nname: a\n"))).toBe(false);
    expect(isZipArchiveBytes(Uint8Array.from([0x50, 0x4b]))).toBe(false);
  });
});
