import { toolDefinition } from "@tanstack/ai";
import { panic, Result } from "better-result";
import * as v from "valibot";

import { SKILL_FILE_NAME, SKILL_PACKAGE_LIMITS } from "@stll/skills/format";
import { normalizeUnicode } from "@stll/text-normalize";

import type { SafeDb, SafeDbError } from "@/api/db/safe-db";
import { AGENT_SKILL_SCOPES } from "@/api/db/schema";
import { raiseChatToolError } from "@/api/handlers/chat/tools/tool-failure";
import {
  blockingSkillPackageDiagnostics,
  checkSkillPackage,
  type SkillPackageCheck,
} from "@/api/lib/agent-skills/skill-package-check";
import {
  checkSavedSkillPackage,
  createSkillPackage,
  type SkillPackageChanges,
  writeSavedSkillPackage,
} from "@/api/lib/agent-skills/skill-package-store";
import type { AuditRecorder } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import { resourceIdSchema } from "@/api/lib/custom-schema";
import { ChatToolError, HandlerError } from "@/api/lib/errors/tagged-errors";
import { getAppBaseUrl } from "@/api/lib/mcp-connectors/app-urls";
import {
  type AuthorizedMemberRole,
  hasMemberPermission,
} from "@/api/lib/permission-authorization";
import { toTanStackValibotSchema as toTanStackToolSchema } from "@/api/lib/tanstack-ai-schema";

export const VALIDATE_SKILL_PACKAGE_TOOL_NAME = "validate_skill_package";
export const SAVE_SKILL_PACKAGE_TOOL_NAME = "save_skill_package";

/** Files one call carries; a larger package goes over several calls. */
const SKILL_PACKAGE_RESOURCES_PER_CALL_MAX = 50;
/** One file is written whole, as a model holds it at once. */
const RESOURCE_CONTENT_MAX_CHARS =
  SKILL_PACKAGE_LIMITS.resourceModelContextMaxChars;
/** SKILL.md is its body plus a short frontmatter. */
const SKILL_MD_MAX_CHARS = SKILL_PACKAGE_LIMITS.bodyMaxChars + 4096;

const packageInputSchema = v.strictObject({
  skillId: v.optional(
    resourceIdSchema("agentSkill", {
      description: "Saved skill to change. Omit for a new skill.",
    }),
  ),
  scope: v.optional(
    v.pipe(
      v.picklist(AGENT_SKILL_SCOPES),
      v.description(
        "New skill only; default private. team only when the user asks to share it with the organization (admins and owners).",
      ),
    ),
  ),
  skillMd: v.optional(
    v.pipe(
      v.string(),
      v.minLength(1),
      v.maxLength(SKILL_MD_MAX_CHARS),
      v.description(
        "Whole SKILL.md (frontmatter with name and description, then body). Required for a new skill.",
      ),
    ),
  ),
  resources: v.optional(
    v.pipe(
      v.array(
        v.strictObject({
          path: v.pipe(
            v.string(),
            v.minLength(1),
            v.maxLength(SKILL_PACKAGE_LIMITS.resourcePathMaxChars),
            v.description("Such as references/topic.md."),
          ),
          content: v.pipe(v.string(), v.maxLength(RESOURCE_CONTENT_MAX_CHARS)),
        }),
      ),
      v.maxLength(SKILL_PACKAGE_RESOURCES_PER_CALL_MAX),
      v.description("Files to add or replace by path."),
    ),
    [],
  ),
  deletePaths: v.optional(
    v.pipe(
      v.array(
        v.pipe(
          v.string(),
          v.minLength(1),
          v.maxLength(SKILL_PACKAGE_LIMITS.resourcePathMaxChars),
        ),
      ),
      v.maxLength(SKILL_PACKAGE_LIMITS.resourcesPerSkillMax),
      v.description("Saved files to remove."),
    ),
    [],
  ),
});

const LIMITS_SENTENCE =
  `Per call at most ${String(SKILL_PACKAGE_RESOURCES_PER_CALL_MAX)} files of ` +
  `${String(RESOURCE_CONTENT_MAX_CHARS)} characters; a skill holds ` +
  `${String(SKILL_PACKAGE_LIMITS.resourcesPerSkillMax)} files.`;

const VALIDATE_DESCRIPTION =
  "Check a skill package without saving it, by the rules every skill " +
  "install uses. Takes save_skill_package's arguments: no skillId checks " +
  "skillMd and resources as a new skill; skillId checks that saved skill " +
  "after the given changes. Returns status, diagnostics with fixes, " +
  "frontmatter, file sizes and missingReferences.";

const SAVE_DESCRIPTION =
  "Save a skill package (SKILL.md plus text files such as references/*.md) " +
  "to the user's skills. No skillId creates one from skillMd and " +
  "resources; skillId changes that skill. Send a large package over " +
  "several calls with the returned skillId. Checked first: on any problem " +
  "but missingReferences nothing is written. A new skill is saved disabled " +
  `for the user to enable in Knowledge. ${LIMITS_SENTENCE}`;

/** Read the input the way both tools do: one meaning per combination. */
const readPackageInput = (
  raw: v.InferInput<typeof packageInputSchema>,
): Result<
  | {
      type: "new";
      resources: SkillPackageChanges["resources"];
      scope: (typeof AGENT_SKILL_SCOPES)[number];
      skillMd: string;
    }
  | {
      type: "saved";
      changes: SkillPackageChanges;
      skillId: SafeId<"agentSkill">;
    },
  ChatToolError
> => {
  // The model's arguments are read here, where the id brands.
  const parsed = v.safeParse(packageInputSchema, raw);
  if (!parsed.success) {
    return Result.err(
      new ChatToolError({
        kind: "invalid-input",
        message: parsed.issues.map(({ message }) => message).join("; "),
      }),
    );
  }
  const input = parsed.output;
  const invalid = (message: string) =>
    Result.err(new ChatToolError({ kind: "invalid-input", message }));
  // Stored paths are NFC, as an import stores them.
  const resources = input.resources.map(({ content, path }) => ({
    content,
    path: normalizeUnicode(path, "NFC"),
  }));
  const deletePaths = input.deletePaths.map((path) =>
    normalizeUnicode(path, "NFC"),
  );
  if (resources.some(({ path }) => path === SKILL_FILE_NAME)) {
    return invalid(
      "SKILL.md goes in skillMd, not in resources. Send it as skillMd.",
    );
  }
  const written = new Set(resources.map(({ path }) => path));
  const both = deletePaths.find((path) => written.has(path));
  if (both !== undefined) {
    return invalid(
      `${both} is both written and deleted in one call; keep one of the two.`,
    );
  }
  if (input.skillId === undefined) {
    if (input.skillMd === undefined) {
      return invalid(
        "A new skill needs skillMd. To change a saved skill, pass its skillId.",
      );
    }
    if (deletePaths.length > 0) {
      return invalid("A new skill has no saved files to delete.");
    }
    return Result.ok({
      type: "new",
      resources,
      scope: input.scope ?? "private",
      skillMd: input.skillMd,
    });
  }
  if (input.scope === "team") {
    return invalid(
      "scope applies to a new skill only; a saved skill keeps its scope. Omit scope.",
    );
  }
  return Result.ok({
    type: "saved",
    changes: { deletePaths, resources, skillMd: input.skillMd },
    skillId: input.skillId,
  });
};

const toChatToolError = (error: HandlerError | SafeDbError): ChatToolError => {
  if (!HandlerError.is(error)) {
    return new ChatToolError({
      kind: "server-defect",
      message: "The skill could not be read or saved.",
      cause: error,
    });
  }
  if (error.status === 404) {
    return new ChatToolError({
      kind: "not-found",
      message: `${error.message}. Pass a skillId save_skill_package returned, or omit it to make a new skill.`,
    });
  }
  // A refusal the model fixes by changing its call; anything else is ours.
  return error.status === 400 || error.status === 403 || error.status === 409
    ? new ChatToolError({ kind: "invalid-input", message: error.message })
    : new ChatToolError({
        kind: "server-defect",
        message: error.message,
        cause: error,
      });
};

const unwrap = <T>(result: Result<T, HandlerError | SafeDbError>): T =>
  Result.isError(result)
    ? raiseChatToolError(toChatToolError(result.error))
    : result.value;

/** Where the user opens a saved skill. */
const skillUrl = (skillId: SafeId<"agentSkill">) =>
  `${getAppBaseUrl()}/knowledge/tools/${skillId}`;

const nextStep = (check: SkillPackageCheck): string => {
  const blocking = blockingSkillPackageDiagnostics(check);
  if (blocking.length > 0) {
    return "Fix each diagnostic and call again.";
  }
  if (check.missingReferences.length > 0) {
    return "Send the files in missingReferences with save_skill_package and this skillId, or fix the paths in SKILL.md.";
  }
  return "The package is complete.";
};

/**
 * Which skill package tools a turn registers. They are skill authoring
 * tools, so a turn carries them only when one of its skills declares them in
 * `stella-required-tools` (`declared`); every other chat keeps them out of
 * its prompt. `every` is for the sets that must name all a run could offer:
 * persisted-call validation and skill availability, where declaring them is
 * what makes them available.
 */
type SkillPackageToolOffer =
  { type: "declared"; names: ReadonlySet<string> } | { type: "every" };

type CreateSkillPackageToolsProps = {
  memberRole: AuthorizedMemberRole;
  offer: SkillPackageToolOffer;
  organizationId: SafeId<"organization">;
  /** Bound to approved mutations; absent offers only the check. */
  recordAuditEvent: AuditRecorder | undefined;
  safeDb: SafeDb;
  userId: SafeId<"user">;
};

/**
 * Chat's skill authoring: check a package (`validate_skill_package`) and
 * save it (`save_skill_package`), however many files it has, over as many
 * calls as it needs. Offered to members who may create skills.
 */
export const createSkillPackageTools = ({
  memberRole,
  offer,
  organizationId,
  recordAuditEvent,
  safeDb,
  userId,
}: CreateSkillPackageToolsProps) => {
  const access = { memberRole, organizationId, userId };

  const validate = toolDefinition({
    name: VALIDATE_SKILL_PACKAGE_TOOL_NAME,
    description: VALIDATE_DESCRIPTION,
    inputSchema: toTanStackToolSchema(packageInputSchema),
  }).server(async (input) => {
    const read = readPackageInput(input);
    const target = Result.isError(read)
      ? raiseChatToolError(read.error)
      : read.value;
    switch (target.type) {
      case "new": {
        const check = checkSkillPackage({
          resources: target.resources.map(({ content, path }) => ({
            content,
            path,
            type: "text" as const,
          })),
          skillMd: target.skillMd,
        });
        return { ...check, skillId: null, next: nextStep(check) };
      }
      case "saved": {
        const { check, skill } = unwrap(
          unwrap(
            await checkSavedSkillPackage({
              ...access,
              changes: target.changes,
              safeDb,
              skillId: target.skillId,
            }),
          ),
        );
        return { ...check, skillId: skill.id, next: nextStep(check) };
      }
      default:
        target satisfies never;
        return panic("Unknown skill package target.");
    }
  });

  const save = toolDefinition({
    name: SAVE_SKILL_PACKAGE_TOOL_NAME,
    description: SAVE_DESCRIPTION,
    inputSchema: toTanStackToolSchema(packageInputSchema),
  }).server(async (input) => {
    const auditRecorder =
      recordAuditEvent ??
      raiseChatToolError(
        new ChatToolError({
          kind: "server-defect",
          message: "Saving a skill needs an approved, audited chat turn.",
        }),
      );
    const read = readPackageInput(input);
    const target = Result.isError(read)
      ? raiseChatToolError(read.error)
      : read.value;
    switch (target.type) {
      case "new": {
        const outcome = unwrap(
          await createSkillPackage({
            ...access,
            recordAuditEvent: auditRecorder,
            resources: target.resources,
            safeDb,
            scope: target.scope,
            skillMd: target.skillMd,
          }),
        );
        switch (outcome.type) {
          case "rejected":
            return rejected(outcome.check);
          case "name-taken":
            return {
              status: "name_taken" as const,
              skillId: outcome.skill.id,
              name: outcome.skill.name,
              next: "A skill with this name exists already and nothing was written. To continue it, call save_skill_package with this skillId; for a separate skill, change the name in SKILL.md.",
            };
          case "saved":
            return saved({
              check: outcome.check,
              created: outcome.created,
              deleted: [],
              skill: outcome.skill,
              updated: [],
            });
          default:
            outcome satisfies never;
            return panic("Unknown skill save outcome.");
        }
      }
      case "saved": {
        const outcome = unwrap(
          unwrap(
            await writeSavedSkillPackage({
              ...access,
              changes: target.changes,
              recordAuditEvent: auditRecorder,
              safeDb,
              skillId: target.skillId,
            }),
          ),
        );
        return outcome.type === "rejected"
          ? rejected(outcome.check)
          : saved(outcome);
      }
      default:
        target satisfies never;
        return panic("Unknown skill package target.");
    }
  });

  const canAuthor = hasMemberPermission(memberRole, {
    agentSkill: ["create"],
  });
  const offered = (name: string) =>
    canAuthor && (offer.type === "every" || offer.names.has(name));
  return {
    [VALIDATE_SKILL_PACKAGE_TOOL_NAME]: offered(
      VALIDATE_SKILL_PACKAGE_TOOL_NAME,
    )
      ? validate
      : undefined,
    // Saves record an audit event, which only an approved run carries.
    [SAVE_SKILL_PACKAGE_TOOL_NAME]:
      offered(SAVE_SKILL_PACKAGE_TOOL_NAME) && recordAuditEvent !== undefined
        ? save
        : undefined,
  };
};

const rejected = (check: SkillPackageCheck) => ({
  status: "rejected" as const,
  diagnostics: blockingSkillPackageDiagnostics(check),
  missingReferences: check.missingReferences,
  next: "Nothing was written. Fix each diagnostic (validate_skill_package checks without saving) and call again.",
});

const saved = ({
  check,
  created,
  deleted,
  skill,
  updated,
}: {
  check: SkillPackageCheck;
  created: string[];
  deleted: string[];
  skill: { id: SafeId<"agentSkill">; name: string; scope: string };
  updated: string[];
}) => ({
  status: "saved" as const,
  skillId: skill.id,
  name: skill.name,
  scope: skill.scope,
  url: skillUrl(skill.id),
  created,
  updated,
  deleted,
  complete: check.missingReferences.length === 0,
  missingReferences: check.missingReferences,
  totals: check.totals,
  next: nextStep(check),
});
