import { afterAll, describe, expect, it } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import * as v from "valibot";

import { collectEntries } from "../scripts/generate-manifest";
import { validateCatalogue } from "../scripts/validate";
import {
  githubArchiveUrl,
  githubRawContentBaseUrl,
  isGithubSkillEntry,
  type LoadedCatalogueEntry,
} from "./loader";
import { catalogueEntrySchema } from "./schema";

const FULL_SHA = "a".repeat(40);

const baseSkill = {
  kind: "skill",
  displayName: "German Law",
  description: "Community skill for German legal drafting.",
  author: "acme",
  license: "MIT",
  cost: "free",
  setup: "none",
} as const;

const validGithubSkill = {
  ...baseSkill,
  slug: "german-law",
  source: "github",
  repo: "acme/legal-skills",
  rev: FULL_SHA,
  directory: "skills/german-law",
};

const validInTreeSkill = {
  ...baseSkill,
  slug: "in-tree-skill",
  source: "in-tree",
  entryPath: "SKILL.md",
};

describe("skill source schema", () => {
  it("accepts a github-sourced skill with and without a directory", () => {
    const withDir = v.safeParse(catalogueEntrySchema, validGithubSkill);
    expect(withDir.success).toBe(true);
    if (withDir.success && withDir.output.kind === "skill") {
      expect(withDir.output.source).toBe("github");
    }

    const { directory: _directory, ...withoutDir } = validGithubSkill;
    expect(v.safeParse(catalogueEntrySchema, withoutDir).success).toBe(true);
  });

  it("accepts a migrated in-tree skill", () => {
    expect(v.safeParse(catalogueEntrySchema, validInTreeSkill).success).toBe(
      true,
    );
  });

  it("rejects a malformed repo identifier", () => {
    expect(
      v.safeParse(catalogueEntrySchema, {
        ...validGithubSkill,
        repo: "not-a-repo",
      }).success,
    ).toBe(false);
    expect(
      v.safeParse(catalogueEntrySchema, {
        ...validGithubSkill,
        repo: "acme/legal skills",
      }).success,
    ).toBe(false);
  });

  it("rejects a short or uppercase rev", () => {
    expect(
      v.safeParse(catalogueEntrySchema, { ...validGithubSkill, rev: "abc123" })
        .success,
    ).toBe(false);
    expect(
      v.safeParse(catalogueEntrySchema, {
        ...validGithubSkill,
        rev: "A".repeat(40),
      }).success,
    ).toBe(false);
  });

  it("rejects a directory that escapes the repo", () => {
    expect(
      v.safeParse(catalogueEntrySchema, {
        ...validGithubSkill,
        directory: "../secrets",
      }).success,
    ).toBe(false);
    expect(
      v.safeParse(catalogueEntrySchema, {
        ...validGithubSkill,
        directory: "/absolute",
      }).success,
    ).toBe(false);
  });

  it("requires a license on both variants", () => {
    const { license: _gh, ...githubNoLicense } = validGithubSkill;
    expect(v.safeParse(catalogueEntrySchema, githubNoLicense).success).toBe(
      false,
    );
    const { license: _it, ...inTreeNoLicense } = validInTreeSkill;
    expect(v.safeParse(catalogueEntrySchema, inTreeNoLicense).success).toBe(
      false,
    );
  });

  it("rejects an unknown source", () => {
    expect(
      v.safeParse(catalogueEntrySchema, {
        ...validGithubSkill,
        source: "gitlab",
      }).success,
    ).toBe(false);
  });

  it("rejects in-tree fields on a github skill (strict object)", () => {
    expect(
      v.safeParse(catalogueEntrySchema, {
        ...validGithubSkill,
        entryPath: "SKILL.md",
      }).success,
    ).toBe(false);
  });
});

describe("github url helpers", () => {
  it("builds the pinned raw-content base url with a trailing slash", () => {
    expect(githubRawContentBaseUrl(validGithubSkill)).toBe(
      `https://raw.githubusercontent.com/acme/legal-skills/${FULL_SHA}/skills/german-law/`,
    );
    const { directory: _directory, ...noDir } = validGithubSkill;
    expect(githubRawContentBaseUrl(noDir)).toBe(
      `https://raw.githubusercontent.com/acme/legal-skills/${FULL_SHA}/`,
    );
  });

  it("builds the pinned archive url", () => {
    expect(githubArchiveUrl(validGithubSkill)).toBe(
      `https://codeload.github.com/acme/legal-skills/zip/${FULL_SHA}`,
    );
  });

  it("narrows github-sourced skills via the type guard", () => {
    const loadedGithub: LoadedCatalogueEntry = {
      ...v.parse(catalogueEntrySchema, validGithubSkill),
      icon: null,
    };
    const loadedInTree: LoadedCatalogueEntry = {
      ...v.parse(catalogueEntrySchema, validInTreeSkill),
      icon: null,
    };
    expect(isGithubSkillEntry(loadedGithub)).toBe(true);
    expect(isGithubSkillEntry(loadedInTree)).toBe(false);
  });
});

const tempRoots: string[] = [];

const makeEntriesRoot = (): string => {
  const root = mkdtempSync(path.join(tmpdir(), "catalogue-test-"));
  tempRoots.push(root);
  return root;
};

const writeSkill = (
  root: string,
  slug: string,
  manifest: unknown,
  extraFiles: Record<string, string> = {},
): void => {
  const folder = path.join(root, "skills", slug);
  mkdirSync(folder, { recursive: true });
  writeFileSync(path.join(folder, "manifest.json"), JSON.stringify(manifest));
  for (const [name, content] of Object.entries(extraFiles)) {
    writeFileSync(path.join(folder, name), content);
  }
};

afterAll(() => {
  for (const root of tempRoots) {
    rmSync(root, { force: true, recursive: true });
  }
});

describe("catalogue filesystem safety", () => {
  it("rejects a dangling nested symlink before reading manifests", () => {
    const root = makeEntriesRoot();
    writeSkill(root, "in-tree-skill", validInTreeSkill, {
      "SKILL.md": "# body",
    });
    const folder = path.join(root, "skills", "in-tree-skill");
    const nestedFolder = path.join(folder, "resources");
    mkdirSync(nestedFolder);
    symlinkSync("missing-secret", path.join(nestedFolder, "secret.txt"));
    writeFileSync(path.join(folder, "manifest.json"), "{ invalid json");

    expect(() => validateCatalogue(root)).toThrow(
      /symbolic links are forbidden/u,
    );
    expect(() => collectEntries(root)).toThrow(/symbolic links are forbidden/u);
  });

  it("rejects a FIFO icon before reading manifests", () => {
    const root = makeEntriesRoot();
    writeSkill(root, "german-law", validGithubSkill);
    const folder = path.join(root, "skills", "german-law");
    const fifoPath = path.join(folder, "icon.svg");
    const { exitCode } = Bun.spawnSync(["mkfifo", fifoPath]);
    expect(exitCode).toBe(0);
    writeFileSync(path.join(folder, "manifest.json"), "{ invalid json");

    expect(() => validateCatalogue(root)).toThrow(
      /only directories and regular files are allowed/u,
    );
    expect(() => collectEntries(root)).toThrow(
      /only directories and regular files are allowed/u,
    );
  });
});

describe("validateCatalogue with github entries", () => {
  it("passes a github skill folder holding only a manifest and icon", () => {
    const root = makeEntriesRoot();
    writeSkill(root, "german-law", validGithubSkill, {
      "icon.svg": "<svg/>",
    });
    const { entryCount, errors } = validateCatalogue(root);
    expect(errors).toEqual([]);
    expect(entryCount).toBe(1);
  });

  it("rejects local content files in a github skill folder", () => {
    const root = makeEntriesRoot();
    writeSkill(root, "german-law", validGithubSkill, {
      "SKILL.md": "# leaked content",
    });
    const { errors } = validateCatalogue(root);
    expect(
      errors.some((error) => error.includes("must not include local content")),
    ).toBe(true);
  });

  it("ignores hidden OS metadata in a github skill folder", () => {
    const root = makeEntriesRoot();
    writeSkill(root, "german-law", validGithubSkill, {
      ".DS_Store": "finder metadata",
    });
    expect(validateCatalogue(root).errors).toEqual([]);
  });

  it("still rejects hidden local content in a github skill folder", () => {
    const root = makeEntriesRoot();
    writeSkill(root, "german-law", validGithubSkill, {
      ".private-notes": "local content",
    });
    expect(
      validateCatalogue(root).errors.some((error) =>
        error.includes("must not include local content"),
      ),
    ).toBe(true);
  });

  it("still surfaces schema errors (bad rev) for github skills", () => {
    const root = makeEntriesRoot();
    writeSkill(root, "german-law", { ...validGithubSkill, rev: "abc" });
    const { errors } = validateCatalogue(root);
    expect(errors.length).toBeGreaterThan(0);
  });

  it("keeps in-tree entryPath existence checks unchanged", () => {
    const missing = makeEntriesRoot();
    writeSkill(missing, "in-tree-skill", validInTreeSkill);
    expect(
      validateCatalogue(missing).errors.some((error) =>
        error.includes("entryPath file not found"),
      ),
    ).toBe(true);

    const present = makeEntriesRoot();
    writeSkill(present, "in-tree-skill", validInTreeSkill, {
      "SKILL.md": "# body",
    });
    expect(validateCatalogue(present).errors).toEqual([]);
  });

  it("checks recommended.json references against both sources", () => {
    const root = makeEntriesRoot();
    writeSkill(root, "german-law", validGithubSkill);
    writeFileSync(
      path.join(root, "recommended.json"),
      JSON.stringify({ DE: ["german-law"], FR: ["missing"] }),
    );
    const { errors } = validateCatalogue(root);
    expect(
      errors.some((error) => error.includes('unknown slug "missing"')),
    ).toBe(true);
    expect(errors.some((error) => error.includes("german-law"))).toBe(false);
  });
});

describe("collectEntries source handling", () => {
  it("bundles github skills but excludes them from install payloads", () => {
    const root = makeEntriesRoot();
    writeSkill(root, "german-law", validGithubSkill);
    writeSkill(root, "in-tree-skill", validInTreeSkill, {
      "SKILL.md": "# body",
    });

    const entries = collectEntries(root);
    expect(entries.length).toBe(2);

    const github = entries.find(
      (entry) => entry.importName === "skillGermanLaw",
    );
    const inTree = entries.find(
      (entry) => entry.importName === "skillInTreeSkill",
    );

    expect(github?.skillPayload).toBeNull();
    expect(inTree?.skillPayload).not.toBeNull();
    expect(inTree?.skillPayload?.slugLiteral).toBe('"in-tree-skill"');
  });
});
