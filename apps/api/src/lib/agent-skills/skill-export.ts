import { Result } from "better-result";
import { and, asc, eq } from "drizzle-orm";

import {
  SKILL_EXPORT_TOO_LARGE_CODE,
  SKILL_PACKAGE_SKILL_NOT_FOUND_CODE,
} from "@stll/api-contract";
import { ZipArchive } from "@stll/docx-core/zip";
import { sha256Hex } from "@stll/sha256/bun";
import {
  isKnownBinaryResourcePath,
  SKILL_PACKAGE_LIMITS,
} from "@stll/skills/format";
import { buildSkillPackage } from "@stll/skills/package";
import type {
  SkillArchiveEntry,
  SkillPackageSource,
} from "@stll/skills/package";

import type { Transaction } from "@/api/db/root";
import { agentSkillResources, agentSkills } from "@/api/db/schema";
import { readSkillResourceOriginals } from "@/api/lib/agent-skills/resource-originals";
import type { SkillResourceOriginal } from "@/api/lib/agent-skills/resource-originals";
import { renderSkillFile } from "@/api/lib/agent-skills/skill-file";
import type { SafeId } from "@/api/lib/branded-types";
import { readBounded } from "@/api/lib/db/read-bounded";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";
import { readTenantS3ArrayBuffer } from "@/api/lib/s3-presign";

const UTF8_ENCODER = new TextEncoder();

/** How long one original's read from object storage may take. */
const ORIGINAL_READ_TIMEOUT_MS = 30_000;

/**
 * Where a stored text file goes in a package. A file kept as the text
 * extracted from a PDF or DOCX holds Markdown, not the format its name says,
 * so it is exported under `.md` (beside the name it had, if that is free)
 * rather than as a file no reader could open.
 */
const exportedResourcePath = (
  path: string,
  taken: ReadonlySet<string>,
): string => {
  if (!isKnownBinaryResourcePath(path)) {
    return path;
  }
  const dot = path.lastIndexOf(".");
  const replaced = `${path.slice(0, dot)}.md`;
  return taken.has(replaced) ? `${path}.md` : replaced;
};

/** A skill with more files or bytes than one package carries. */
const skillTooLargeToExport = () =>
  new HandlerError({
    code: SKILL_EXPORT_TOO_LARGE_CODE,
    status: 413,
    message: "Skill is too large to export as one package",
  });

/**
 * A skill as read for export: everything but the originals' bytes, which
 * live in object storage and are read outside the transaction.
 */
type LoadedSkillPackage = SkillPackageSource & {
  /** Files kept with their original bytes, by their path in the skill. */
  originals: readonly { original: SkillResourceOriginal; path: string }[];
  resourceCount: number;
};

/**
 * One skill as the package it exports to, read in one transaction under the
 * caller's row security: a skill the caller cannot read (another member's
 * private skill, a skill bound to a matter or client the caller does not
 * reach, another organization's) is not found. The package carries no
 * binding and no matter data: the importer chooses where it lands.
 */
export const loadSkillPackageSource = async (
  tx: Transaction,
  {
    organizationId,
    skillId,
    userId,
  }: {
    organizationId: SafeId<"organization">;
    skillId: SafeId<"agentSkill">;
    userId: SafeId<"user">;
  },
): Promise<Result<LoadedSkillPackage, HandlerError>> => {
  const skill = (
    await tx
      .select({
        body: agentSkills.body,
        command: agentSkills.command,
        compatibility: agentSkills.compatibility,
        description: agentSkills.description,
        invocation: agentSkills.invocation,
        license: agentSkills.license,
        metadata: agentSkills.metadata,
        name: agentSkills.name,
        scope: agentSkills.scope,
        slug: agentSkills.slug,
        userId: agentSkills.userId,
        version: agentSkills.version,
      })
      .from(agentSkills)
      .where(
        and(
          eq(agentSkills.id, skillId),
          eq(agentSkills.organizationId, organizationId),
        ),
      )
      .limit(1)
  ).at(0);
  // The row policy already hides another member's private skill; the check
  // keeps the answer the same if a policy ever widens.
  if (
    skill === undefined ||
    (skill.scope === "private" && skill.userId !== userId)
  ) {
    return Result.err(
      new HandlerError({
        code: SKILL_PACKAGE_SKILL_NOT_FOUND_CODE,
        status: 404,
        message: "Skill not found",
      }),
    );
  }
  // Bounded by the per-skill file cap; a package must never drop a file
  // silently, so a skill past it is refused below.
  const read = await readBounded(
    tx
      .select({
        content: agentSkillResources.content,
        path: agentSkillResources.path,
      })
      .from(agentSkillResources)
      .where(eq(agentSkillResources.skillId, skillId))
      .orderBy(asc(agentSkillResources.path)),
    LIMITS.agentSkillResourcesPerSkill,
  );
  if (read.type === "overflow") {
    return Result.err(skillTooLargeToExport());
  }
  const { rows } = read;
  const originals = await readSkillResourceOriginals(tx, skillId);
  const packageBytes = rows.reduce(
    (total, { content, path }) =>
      total +
      (originals.get(path)?.sizeBytes ??
        UTF8_ENCODER.encode(content).byteLength),
    0,
  );
  // Writes are held to the package size now; a skill saved before that
  // could hold more than one package carries.
  if (packageBytes > SKILL_PACKAGE_LIMITS.packageFilesMaxBytes) {
    return Result.err(skillTooLargeToExport());
  }
  const taken = new Set(rows.map(({ path }) => path));
  const resources: SkillArchiveEntry[] = [];
  const kept: { original: SkillResourceOriginal; path: string }[] = [];
  for (const { content, path } of rows) {
    // A file kept with its original travels as those bytes at its own path;
    // the text beside it was derived from them.
    const original = originals.get(path);
    if (original !== undefined) {
      kept.push({ original, path });
      continue;
    }
    const exported = exportedResourcePath(path, taken);
    taken.add(exported);
    resources.push({ bytes: UTF8_ENCODER.encode(content), path: exported });
  }
  return Result.ok({
    command: skill.command,
    displayName: skill.name,
    originals: kept,
    resourceCount: rows.length,
    resources,
    skillMd: renderSkillFile(skill),
    slug: skill.slug,
  });
};

/** Reads one stored original's bytes, within its organization's keys. */
export type SkillOriginalReader = (input: {
  key: string;
  organizationId: SafeId<"organization">;
  signal: AbortSignal;
}) => Promise<ArrayBuffer>;

/**
 * An original read with the tenant client, which refuses any key outside
 * the organization's prefix. The bytes are only checked against their
 * recorded digest and archived, never parsed.
 */
export const readStoredSkillOriginal: SkillOriginalReader = async ({
  key,
  organizationId,
  signal,
}: {
  key: string;
  organizationId: SafeId<"organization">;
  signal: AbortSignal;
}) =>
  await readTenantS3ArrayBuffer({
    key,
    scope: { organizationId, workspaceId: null },
    signal,
  });

/**
 * The package source with every original's bytes in place, each checked
 * against the digest and size recorded when it was stored. An original that
 * cannot be read or no longer matches fails the export instead of shipping a
 * package that would silently differ from the skill.
 */
export const withSkillOriginals = async ({
  loaded,
  organizationId,
  readObject,
}: {
  loaded: LoadedSkillPackage;
  organizationId: SafeId<"organization">;
  readObject: SkillOriginalReader;
}): Promise<Result<SkillPackageSource, HandlerError>> => {
  const originals: SkillArchiveEntry[] = [];
  for (const { original, path } of loaded.originals) {
    const read = await Result.tryPromise(
      async () =>
        await readObject({
          key: original.s3Key,
          organizationId,
          signal: AbortSignal.timeout(ORIGINAL_READ_TIMEOUT_MS),
        }),
    );
    if (Result.isError(read)) {
      return Result.err(
        new HandlerError({
          status: 503,
          code: "upstream_unavailable",
          message: "A file of the skill could not be read. Retry the export.",
          cause: read.error,
        }),
      );
    }
    const bytes = new Uint8Array(read.value);
    if (
      bytes.byteLength !== original.sizeBytes ||
      sha256Hex(bytes) !== original.sha256
    ) {
      return Result.err(
        new HandlerError({
          status: 500,
          code: "internal_error",
          message: "A stored file of the skill no longer matches its record.",
        }),
      );
    }
    originals.push({ bytes, path });
  }
  return Result.ok({
    command: loaded.command,
    displayName: loaded.displayName,
    resources: [...loaded.resources, ...originals],
    skillMd: loaded.skillMd,
    slug: loaded.slug,
  });
};

/** The package as zip bytes; `.zip` and `.skill` hold the same archive. */
export const writeSkillPackageArchive = async (
  source: SkillPackageSource,
): Promise<Uint8Array> => {
  const zip = new ZipArchive();
  const entries: SkillArchiveEntry[] = buildSkillPackage(source);
  for (const entry of entries) {
    zip.set(entry.path, entry.bytes);
  }
  return await zip.generate();
};
