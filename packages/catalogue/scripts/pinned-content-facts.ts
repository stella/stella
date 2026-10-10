import { panic, Result, TaggedError } from "better-result";
import type { MaybePromise } from "bun";
import nodePath from "node:path";
import * as v from "valibot";

import { sha256Hex } from "@stll/sha256/bun";
import type { SkillMetadata } from "@stll/skills/frontmatter";
import { stableStringify } from "@stll/stable-stringify";

import { isGithubSkillEntry, loadCatalogue } from "../src/loader";
import { CATALOGUE_LICENSES } from "../src/schema";

export class PinnedContentError extends TaggedError("PinnedContentError")<{
  message: string;
}> {}
const GITHUB_CONTENTS_LISTING_LIMIT = 1000;
const count = v.pipe(v.number(), v.integer(), v.minValue(0));
const digest = v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/u));
const fileFields = { sha256: digest, byteLength: count, utf16Length: count };
const fileSchema = v.strictObject(fileFields);
const frontmatterSchema = v.strictObject({
  name: v.string(),
  license: v.nullable(v.string()),
  descriptionUtf16Length: count,
  versionUtf16Length: count,
  licenseUtf16Length: count,
  compatibilityUtf16Length: count,
  metadata: v.array(
    v.variant("type", [
      v.strictObject({
        type: v.literal("stella"),
        key: v.string(),
        value: v.string(),
      }),
      v.strictObject({
        type: v.literal("other"),
        keyUtf16Length: count,
        valueUtf16Length: count,
      }),
    ]),
  ),
});
const skillSchema = v.strictObject({
  ...fileFields,
  bodyUtf16Length: count,
  referencedResourcePaths: v.array(v.string()),
  frontmatter: frontmatterSchema,
});
const targetSchema = v.strictObject({
  slug: v.string(),
  repo: v.string(),
  rev: v.pipe(v.string(), v.regex(/^[a-f0-9]{40}$/u)),
  directory: v.string(),
  license: v.picklist(CATALOGUE_LICENSES),
});
const itemSchema = v.strictObject({
  path: v.string(),
  type: v.string(),
  size: v.nullable(count),
});
const listingSchema = v.strictObject({
  path: v.string(),
  itemCount: count,
  items: v.array(itemSchema),
});
const entrySchema = v.strictObject({
  target: targetSchema,
  skill: skillSchema,
  directories: v.array(listingSchema),
  resources: v.array(v.strictObject({ path: v.string(), ...fileFields })),
});
const snapshotSchema = v.strictObject({
  version: v.literal(2),
  parserFingerprint: digest,
  factsSha256: digest,
  entries: v.array(entrySchema),
});
export type GithubTarget = v.InferOutput<typeof targetSchema>;
export type GithubContentItem = v.InferOutput<typeof itemSchema>;
export type FrontmatterFacts = v.InferOutput<typeof frontmatterSchema>;
type FileFacts = v.InferOutput<typeof fileSchema>;
type SkillFacts = v.InferOutput<typeof skillSchema>;
type EntryFacts = v.InferOutput<typeof entrySchema>;
type PinnedSnapshotSource = PinnedSource & {
  entries: EntryFacts[];
};
export type PinnedSource = {
  skill: (target: GithubTarget) => MaybePromise<SkillFacts | null>;
  directory: (args: {
    target: GithubTarget;
    directory: string;
  }) => MaybePromise<{ itemCount: number; items: GithubContentItem[] }>;
  resource: (args: {
    target: GithubTarget;
    path: string;
  }) => MaybePromise<FileFacts | null>;
};
export const PINNED_SNAPSHOT_PATH = nodePath.resolve(
  import.meta.dir,
  "../upstream/pinned-content.gen.json",
);
const root = nodePath.resolve(import.meta.dir, "../../..");
const PARSER_INPUTS = [
  "packages/skills/src/loader.ts",
  "packages/skills/src/format.ts",
  "packages/skills/package.json",
  "packages/catalogue/scripts/pinned-content-facts.ts",
  "packages/catalogue/scripts/pinned-content-upstream.ts",
  "packages/catalogue/scripts/check-pinned-content.ts",
] as const;

const compareKeys = (left: string, right: string): number => {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
};

export const projectFrontmatter = (
  metadata: SkillMetadata,
): FrontmatterFacts => ({
  name: metadata.name,
  license: metadata.license?.trim() ?? null,
  descriptionUtf16Length: metadata.description.length,
  versionUtf16Length: metadata.version?.length ?? 0,
  licenseUtf16Length: metadata.license?.length ?? 0,
  compatibilityUtf16Length: metadata.compatibility?.length ?? 0,
  metadata: Object.entries(metadata.metadata ?? {})
    .toSorted(([left], [right]) => compareKeys(left, right))
    .map(([key, value]) =>
      key.startsWith("stella-")
        ? { type: "stella" as const, key, value }
        : {
            type: "other" as const,
            keyUtf16Length: key.length,
            valueUtf16Length: value.length,
          },
    ),
});

export const assertCompleteGithubContentsListing = ({
  itemCount,
  repoRelativePath,
}: {
  itemCount: number;
  repoRelativePath: string;
}): void => {
  if (itemCount < GITHUB_CONTENTS_LISTING_LIMIT) {
    return;
  }
  throw new PinnedContentError({
    message: `GitHub contents listing may be truncated at ${GITHUB_CONTENTS_LISTING_LIMIT} entries for ${repoRelativePath || "<root>"}`,
  });
};
const fingerprint = async () =>
  sha256Hex(
    (
      await Promise.all(
        PARSER_INPUTS.map(
          async (file) =>
            `${file}\n${await Bun.file(nodePath.join(root, file)).text()}`,
        ),
      )
    ).join("\n"),
  );
export const serializePinnedSnapshot = (
  snapshot: v.InferOutput<typeof snapshotSchema>,
): string => {
  const canonical: unknown = JSON.parse(stableStringify(snapshot));
  return `${JSON.stringify(canonical, null, 2)}\n`;
};
export const buildPinnedSnapshot = async (entries: EntryFacts[]) => {
  const parsed = v.safeParse(v.array(entrySchema), entries);
  if (!parsed.success) {
    throw new PinnedContentError({ message: "Pinned facts schema is invalid" });
  }
  const detachedEntries = parsed.output;
  return {
    version: 2 as const,
    parserFingerprint: await fingerprint(),
    factsSha256: sha256Hex(stableStringify(detachedEntries)),
    entries: detachedEntries,
  };
};
export const writePinnedSnapshot = async (entries: EntryFacts[]) => {
  const snapshot = await buildPinnedSnapshot(entries);
  const parsed = v.safeParse(snapshotSchema, snapshot);
  if (!parsed.success) {
    throw new PinnedContentError({
      message: "Refreshed pinned facts do not satisfy the snapshot schema",
    });
  }
  await Bun.write(PINNED_SNAPSHOT_PATH, serializePinnedSnapshot(parsed.output));
};

/** Record only facts the install preflight uses; transient upstream text never enters this record. */
export const recordingPinnedSource = (upstream: PinnedSource) => {
  const recorded = new Map<string, EntryFacts>();
  const entry = (target: GithubTarget) => {
    const value = recorded.get(target.slug);
    if (!value) {
      throw new PinnedContentError({
        message: `${target.slug}: SKILL.md facts are missing`,
      });
    }
    return value;
  };
  const source: PinnedSource = {
    skill: async (target) => {
      const skill = await upstream.skill(target);
      if (skill !== null) {
        recorded.set(target.slug, {
          target,
          skill,
          directories: [],
          resources: [],
        });
      }
      return skill;
    },
    directory: async (args) => {
      const listing = await upstream.directory(args);
      entry(args.target).directories.push({
        path: args.directory,
        itemCount: listing.itemCount,
        items: listing.items.toSorted((left, right) =>
          compareKeys(left.path, right.path),
        ),
      });
      return listing;
    },
    resource: async (args) => {
      const resource = await upstream.resource(args);
      if (resource !== null) {
        entry(args.target).resources.push({ path: args.path, ...resource });
      }
      return resource;
    },
  };
  return {
    source,
    entries: () =>
      [...recorded.values()]
        .map((item) => ({
          ...item,
          directories: item.directories.toSorted((left, right) =>
            compareKeys(left.path, right.path),
          ),
          resources: item.resources.toSorted((left, right) =>
            compareKeys(left.path, right.path),
          ),
        }))
        .toSorted((left, right) =>
          compareKeys(left.target.slug, right.target.slug),
        ),
  };
};

export const readPinnedSnapshot = async (
  targets: GithubTarget[],
  file = PINNED_SNAPSHOT_PATH,
): Promise<PinnedSnapshotSource> => {
  const read = await Result.tryPromise(async () => Bun.file(file).text());
  if (read.isErr()) {
    throw new PinnedContentError({
      message: "Pinned facts are missing; run refresh-pinned",
    });
  }
  const decoded = Result.try((): unknown => JSON.parse(read.value));
  const parsed = decoded.isOk()
    ? v.safeParse(snapshotSchema, decoded.value)
    : null;
  if (parsed === null || !parsed.success) {
    throw new PinnedContentError({
      message: "Pinned facts schema is invalid; run refresh-pinned",
    });
  }
  const snapshot = parsed.output;
  if (snapshot.parserFingerprint !== (await fingerprint())) {
    throw new PinnedContentError({
      message: "Pinned facts parser fingerprint is stale; run refresh-pinned",
    });
  }
  if (
    snapshot.factsSha256 !== sha256Hex(stableStringify(snapshot.entries)) ||
    serializePinnedSnapshot(snapshot) !== read.value
  ) {
    throw new PinnedContentError({
      message:
        "Pinned facts digest or canonical content mismatches; run refresh-pinned",
    });
  }
  const entries = new Map(
    snapshot.entries.map((item) => [item.target.slug, item]),
  );
  if (
    entries.size !== snapshot.entries.length ||
    entries.size !== targets.length
  ) {
    throw new PinnedContentError({
      message: "Pinned facts must enumerate every github skill exactly once",
    });
  }
  for (const item of snapshot.entries) {
    for (const records of [item.directories, item.resources]) {
      if (new Set(records.map(({ path }) => path)).size !== records.length) {
        throw new PinnedContentError({
          message: `${item.target.slug}: duplicate pinned facts paths`,
        });
      }
    }
  }
  for (const target of targets) {
    const item = entries.get(target.slug);
    if (!item || stableStringify(item.target) !== stableStringify(target)) {
      throw new PinnedContentError({
        message: `${target.slug}: pinned facts identity mismatches the catalogue; run refresh-pinned`,
      });
    }
  }
  const get = (target: GithubTarget) => {
    const item = entries.get(target.slug);
    if (!item) {
      throw new PinnedContentError({
        message: `${target.slug}: pinned facts missing`,
      });
    }
    return item;
  };
  return {
    entries: snapshot.entries,
    skill: (target) => get(target).skill,
    directory: ({ target, directory }) => {
      const listing = get(target).directories.find(
        (item) => item.path === directory,
      );
      if (!listing) {
        throw new PinnedContentError({
          message: `${target.slug}: directory facts missing for ${directory}`,
        });
      }
      return listing;
    },
    resource: ({ target, path }) => {
      const resource = get(target).resources.find((item) => item.path === path);
      if (!resource) {
        throw new PinnedContentError({
          message: `${target.slug}: resource facts missing for ${path}`,
        });
      }
      return resource;
    },
  };
};

export const collectGithubTargets = (): GithubTarget[] =>
  loadCatalogue()
    .filter(isGithubSkillEntry)
    .map((entry) => ({
      directory: entry.directory ?? "",
      license: entry.license,
      repo: entry.repo,
      rev: entry.rev,
      slug: entry.slug,
    }));

const repeatedMetadataKey = (length: number, index: number): string => {
  const suffix = index.toString(36);
  return `${"k".repeat(Math.max(0, length - suffix.length))}${suffix}`.slice(
    -length,
  );
};

export const syntheticSkillSource = (
  frontmatter: FrontmatterFacts,
  bodyLength: number,
  referencedResourcePaths: readonly string[],
): string => {
  const lines = [
    "---",
    `name: ${JSON.stringify(frontmatter.name)}`,
    `description: ${JSON.stringify("d".repeat(frontmatter.descriptionUtf16Length))}`,
  ];
  if (frontmatter.versionUtf16Length > 0) {
    lines.push(
      `version: ${JSON.stringify("v".repeat(frontmatter.versionUtf16Length))}`,
    );
  }
  if (frontmatter.license !== null) {
    lines.push(`license: ${JSON.stringify(frontmatter.license)}`);
  }
  if (frontmatter.compatibilityUtf16Length > 0) {
    lines.push(
      `compatibility: ${JSON.stringify("c".repeat(frontmatter.compatibilityUtf16Length))}`,
    );
  }
  if (frontmatter.metadata.length > 0) {
    lines.push("metadata:");
    for (const [index, entry] of frontmatter.metadata.entries()) {
      switch (entry.type) {
        case "stella":
          lines.push(
            `  ${JSON.stringify(entry.key)}: ${JSON.stringify(entry.value)}`,
          );
          break;
        case "other": {
          const key = repeatedMetadataKey(entry.keyUtf16Length, index);
          lines.push(
            `  ${JSON.stringify(key)}: ${JSON.stringify("v".repeat(entry.valueUtf16Length))}`,
          );
          break;
        }
        default:
          entry satisfies never;
          return panic("Unknown pinned metadata fact");
      }
    }
  }
  const references = referencedResourcePaths
    .map((resourcePath) => `\`${resourcePath}\``)
    .join("");
  if (references.length > bodyLength) {
    return panic("Pinned skill references exceed the recorded body length");
  }
  lines.push(
    "---",
    "",
    `${references}${"b".repeat(bodyLength - references.length)}`,
  );
  return lines.join("\n");
};
