import { panic, Result } from "better-result";
import { and, eq, inArray, sql } from "drizzle-orm";

import { SKILL_PACKAGE_SKILL_NOT_FOUND_CODE } from "@stll/api-contract";
import { SKILL_FILE_NAME } from "@stll/skills/format";
import { parseSkillFile } from "@stll/skills/frontmatter";

import type { Transaction } from "@/api/db/root";
import type { SafeDb, SafeDbError } from "@/api/db/safe-db";
import { agentSkillResources, agentSkills } from "@/api/db/schema";
import type { AgentSkillScope } from "@/api/db/schema";
import { requireSkillManager } from "@/api/handlers/skills/managed-skill";
import { uniqueSlug } from "@/api/handlers/skills/slug";
import { auditedSkillBody } from "@/api/lib/agent-skills/audited-body";
import { UNBOUND } from "@/api/lib/agent-skills/binding";
import {
  lockSkillForResourceWrite,
  skillContentHashAfter,
} from "@/api/lib/agent-skills/content-hash";
import { requireEditableSkillOrigin } from "@/api/lib/agent-skills/origin";
import {
  renderSkillFile,
  skillFileName,
} from "@/api/lib/agent-skills/skill-file";
import {
  blockingSkillPackageDiagnostics,
  checkSkillPackage,
  type SkillPackageCheck,
  type SkillPackageEntry,
  type SkillPackageResourceInput,
} from "@/api/lib/agent-skills/skill-package-check";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { AuditRecorder } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import { withAggregateSavepoint } from "@/api/lib/db/aggregate-lock";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import type { AuthorizedMemberRole } from "@/api/lib/permission-authorization";
import { installSkill } from "@/api/lib/skills/install";
import { parseSkillFiles } from "@/api/lib/skills/skill-package";

const UTF8_ENCODER = new TextEncoder();

/** What one call changes in a package. */
export type SkillPackageChanges = {
  /** Paths to remove; a path the package does not hold is left alone. */
  deletePaths: readonly string[];
  /** Files to add, or to replace when the package holds the path. */
  resources: readonly SkillPackageResourceInput[];
  /** A replacement SKILL.md; absent keeps the stored one. */
  skillMd: string | undefined;
};

type StoredResource = {
  chars: number;
  id: SafeId<"agentSkillResource">;
  path: string;
  sizeBytes: number;
};

type SavedSkill = {
  id: SafeId<"agentSkill">;
  name: string;
  scope: AgentSkillScope;
  skillMd: string;
  slug: string;
};

type SavedSkillPackage = {
  resources: StoredResource[];
  skill: SavedSkill;
};

type SkillAccess = {
  memberRole: AuthorizedMemberRole;
  organizationId: SafeId<"organization">;
  skillId: SafeId<"agentSkill">;
  userId: SafeId<"user">;
};

/**
 * A saved skill the caller may edit, as SKILL.md and its resource list. With
 * `lock` the row is locked for the resource writes that follow. Content is
 * left in the database: each resource was checked when it was written.
 */
const loadSavedSkillPackage = async (
  tx: Transaction,
  {
    lock,
    memberRole,
    organizationId,
    skillId,
    userId,
  }: SkillAccess & {
    lock: boolean;
  },
): Promise<Result<SavedSkillPackage, HandlerError>> => {
  if (lock) {
    await lockSkillForResourceWrite(tx, skillId);
  }
  const rows = await tx
    .select({
      body: agentSkills.body,
      boundClientId: agentSkills.boundClientId,
      boundWorkspaceId: agentSkills.boundWorkspaceId,
      compatibility: agentSkills.compatibility,
      description: agentSkills.description,
      id: agentSkills.id,
      invocation: agentSkills.invocation,
      license: agentSkills.license,
      metadata: agentSkills.metadata,
      name: agentSkills.name,
      origin: agentSkills.origin,
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
    .limit(1);
  const skill = rows.at(0);
  if (skill === undefined) {
    return Result.err(
      new HandlerError({
        code: SKILL_PACKAGE_SKILL_NOT_FOUND_CODE,
        status: 404,
        message: "Skill not found",
      }),
    );
  }
  const manager = requireSkillManager({
    action: "edit",
    memberRole,
    skill,
    userId,
  });
  if (Result.isError(manager)) {
    return manager;
  }
  const editable = requireEditableSkillOrigin(skill.origin);
  if (Result.isError(editable)) {
    return editable;
  }
  const resources = await tx
    .select({
      chars: sql<number>`char_length(${agentSkillResources.content})`,
      id: agentSkillResources.id,
      path: agentSkillResources.path,
      sizeBytes: agentSkillResources.sizeBytes,
    })
    .from(agentSkillResources)
    .where(eq(agentSkillResources.skillId, skillId));
  return Result.ok({
    resources,
    skill: {
      id: skill.id,
      name: skill.name,
      scope: skill.scope,
      skillMd: renderSkillFile(skill),
      slug: skill.slug,
    },
  });
};

type ChangedPackage = {
  check: SkillPackageCheck;
  deleted: string[];
};

/** The package a saved one becomes once `changes` apply, checked whole. */
const applyChanges = (
  saved: SavedSkillPackage,
  changes: SkillPackageChanges,
): ChangedPackage => {
  const written = new Set(changes.resources.map(({ path }) => path));
  const deleting = new Set(changes.deletePaths);
  const kept: SkillPackageEntry[] = saved.resources
    .filter(({ path }) => !written.has(path) && !deleting.has(path))
    .map(({ chars, path, sizeBytes }) => ({
      chars,
      path,
      sizeBytes,
      type: "stored",
    }));
  return {
    check: checkSkillPackage({
      resources: [
        ...kept,
        ...changes.resources.map(({ content, path }) => ({
          content,
          path,
          type: "text" as const,
        })),
      ],
      skillMd: changes.skillMd ?? saved.skill.skillMd,
    }),
    deleted: saved.resources
      .filter(({ path }) => deleting.has(path))
      .map(({ path }) => path),
  };
};

/**
 * Check a saved skill as it would be after `changes`, without writing. The
 * same reading `writeSavedSkillPackage` decides on.
 */
export const checkSavedSkillPackage = async ({
  changes,
  safeDb,
  ...access
}: SkillAccess & { changes: SkillPackageChanges; safeDb: SafeDb }) =>
  await safeDb(async (tx) => {
    const saved = await loadSavedSkillPackage(tx, { ...access, lock: false });
    return Result.isError(saved)
      ? saved
      : Result.ok({
          check: applyChanges(saved.value, changes).check,
          skill: { id: saved.value.skill.id },
        });
  });

/** A save that was refused, or what it wrote. */
export type SkillPackageWriteOutcome =
  | { type: "rejected"; check: SkillPackageCheck }
  | {
      type: "saved";
      check: SkillPackageCheck;
      created: string[];
      deleted: string[];
      skill: { id: SafeId<"agentSkill">; name: string; scope: AgentSkillScope };
      updated: string[];
    };

/**
 * Apply `changes` to a saved skill in one transaction: resources upserted by
 * path, `deletePaths` removed, SKILL.md's fields stored when it is replaced.
 * The changed package is checked first and nothing is written when a
 * diagnostic other than a missing reference stands.
 */
export const writeSavedSkillPackage = async ({
  changes,
  recordAuditEvent,
  safeDb,
  ...access
}: SkillAccess & {
  changes: SkillPackageChanges;
  recordAuditEvent: AuditRecorder;
  safeDb: SafeDb;
}) =>
  await safeDb(
    async (tx) =>
      await withAggregateSavepoint(
        tx,
        async (
          innerTx,
        ): Promise<Result<SkillPackageWriteOutcome, HandlerError>> => {
          const loaded = await loadSavedSkillPackage(innerTx, {
            ...access,
            lock: true,
          });
          if (Result.isError(loaded)) {
            return loaded;
          }
          const saved = loaded.value;
          const { check, deleted } = applyChanges(saved, changes);
          if (blockingSkillPackageDiagnostics(check).length > 0) {
            return Result.ok({ type: "rejected", check });
          }

          const storedByPath = new Map(
            saved.resources.map((resource) => [resource.path, resource]),
          );
          const created: string[] = [];
          const updated: string[] = [];
          for (const { content, path } of changes.resources) {
            const sizeBytes = UTF8_ENCODER.encode(content).byteLength;
            const stored = storedByPath.get(path);
            if (stored === undefined) {
              await innerTx.insert(agentSkillResources).values({
                content,
                organizationId: access.organizationId,
                path,
                sizeBytes,
                skillId: saved.skill.id,
              });
              created.push(path);
            } else {
              await innerTx
                .update(agentSkillResources)
                .set({ content, sizeBytes })
                .where(eq(agentSkillResources.id, stored.id));
              updated.push(path);
            }
          }
          if (deleted.length > 0) {
            await innerTx
              .delete(agentSkillResources)
              .where(
                and(
                  eq(agentSkillResources.skillId, saved.skill.id),
                  inArray(agentSkillResources.path, deleted),
                ),
              );
          }

          const fields = skillFieldsOf(changes.skillMd, saved.skill);
          // The hash covers the row and its resources and goes out in the
          // same row write: the revision trigger snapshots the row's hash.
          const contentHash = await skillContentHashAfter(innerTx, {
            patch: fields?.columns ?? {},
            skillId: saved.skill.id,
          });
          await innerTx
            .update(agentSkills)
            .set({ ...fields?.columns, ...fields?.slug, contentHash })
            .where(eq(agentSkills.id, saved.skill.id));

          await recordAuditEvent(innerTx, {
            action: AUDIT_ACTION.UPDATE,
            resourceType: AUDIT_RESOURCE_TYPE.AGENT_SKILL,
            resourceId: saved.skill.id,
            changes: {
              package: {
                old: null,
                new: {
                  bodyReplaced: fields !== null,
                  created,
                  deleted,
                  updated,
                  ...(fields === null
                    ? {}
                    : { body: auditedSkillBody(fields.columns.body) }),
                },
              },
            },
            metadata: { slug: fields?.slug?.slug ?? saved.skill.slug },
          });
          return Result.ok({
            type: "saved",
            check,
            created,
            deleted,
            skill: {
              id: saved.skill.id,
              name: fields?.columns.name ?? saved.skill.name,
              scope: saved.skill.scope,
            },
            updated,
          });
        },
      ),
  );

/**
 * The stored columns a replacement SKILL.md sets. A name the stored one
 * already writes as (a display name and its slugified form) is no rename.
 */
const skillFieldsOf = (skillMd: string | undefined, saved: SavedSkill) => {
  if (skillMd === undefined) {
    return null;
  }
  const parsed = parseSkillFile(skillMd);
  if (parsed.isErr()) {
    return panic("The package check refuses an unreadable SKILL.md first");
  }
  const { body, metadata } = parsed.value;
  const renamed = skillFileName(saved.name) !== metadata.name;
  return {
    columns: {
      body,
      compatibility: metadata.compatibility ?? null,
      description: metadata.description,
      invocation: metadata.invocation,
      license: metadata.license ?? null,
      metadata: metadata.metadata ?? {},
      name: renamed ? metadata.name : saved.name,
      version: metadata.version,
    },
    slug: renamed ? { slug: uniqueSlug(metadata.name) } : undefined,
  };
};

/** A new skill's outcome: refused by the check or a name, or created. */
export type SkillPackageCreateOutcome =
  | { type: "rejected"; check: SkillPackageCheck }
  | {
      type: "name-taken";
      check: SkillPackageCheck;
      skill: { id: SafeId<"agentSkill">; name: string };
    }
  | {
      type: "saved";
      check: SkillPackageCheck;
      created: string[];
      skill: { id: SafeId<"agentSkill">; name: string; scope: AgentSkillScope };
    };

/**
 * Create a disabled skill from a package. A skill of the same name the
 * caller already has in that scope is answered with its id instead, so a
 * repeated call continues that skill rather than creating a second one.
 */
export const createSkillPackage = async ({
  memberRole,
  organizationId,
  recordAuditEvent,
  resources,
  safeDb,
  scope,
  skillMd,
  userId,
}: {
  memberRole: AuthorizedMemberRole;
  organizationId: SafeId<"organization">;
  recordAuditEvent: AuditRecorder;
  resources: readonly SkillPackageResourceInput[];
  safeDb: SafeDb;
  scope: AgentSkillScope;
  skillMd: string;
  userId: SafeId<"user">;
}): Promise<Result<SkillPackageCreateOutcome, HandlerError | SafeDbError>> =>
  await Result.gen(async function* () {
    const check = checkSkillPackage({
      resources: resources.map(({ content, path }) => ({
        content,
        path,
        type: "text",
      })),
      skillMd,
    });
    if (blockingSkillPackageDiagnostics(check).length > 0) {
      return Result.ok<SkillPackageCreateOutcome>({ type: "rejected", check });
    }
    // Missing references are allowed: later calls add the files they name.
    const parsed = yield* parseSkillFiles(
      [
        {
          content: skillMd,
          path: SKILL_FILE_NAME,
          sizeBytes: byteLength(skillMd),
        },
        ...resources.map(({ content, path }) => ({
          content,
          path,
          sizeBytes: byteLength(content),
        })),
      ],
      new Set(),
      { entrypointOnly: true },
    );
    const existing = yield* Result.await(
      safeDb((tx) =>
        tx
          .select({ id: agentSkills.id, name: agentSkills.name })
          .from(agentSkills)
          .where(
            and(
              eq(agentSkills.organizationId, organizationId),
              eq(agentSkills.scope, scope),
              eq(agentSkills.name, parsed.name),
              scope === "private" ? eq(agentSkills.userId, userId) : undefined,
            ),
          )
          .limit(1),
      ),
    );
    const taken = existing.at(0);
    if (taken !== undefined) {
      return Result.ok<SkillPackageCreateOutcome>({
        type: "name-taken",
        check,
        skill: taken,
      });
    }
    const installed = yield* Result.await(
      installSkill({
        binding: UNBOUND,
        enabled: false,
        memberRole,
        origin: "authored",
        parsed,
        recordAuditEvent,
        safeDb,
        scope,
        session: { activeOrganizationId: organizationId },
        slug: uniqueSlug(parsed.name),
        user: { id: userId },
      }),
    );
    return Result.ok<SkillPackageCreateOutcome>({
      type: "saved",
      check,
      created: parsed.resources.map(({ path }) => path),
      skill: { id: installed.id, name: parsed.name, scope },
    });
  });

const byteLength = (text: string) => UTF8_ENCODER.encode(text).byteLength;
