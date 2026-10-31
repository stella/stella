import { Result } from "better-result";
import * as v from "valibot";

import { Temporal } from "@stll/time";

import type { AGENT_SKILL_SCOPES } from "@/api/db/schema";
import { skillRealtimeUpdates } from "@/api/handlers/realtime-resource-sets";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { grantThirdPartyOutboundPermit } from "@/api/lib/auth/third-party-outbound-permit";
import { LIMITS } from "@/api/lib/limits";
import {
  authorizeSkillInstallScope,
  installSkill,
  SKILL_INSTALL_ERROR_CODE,
} from "@/api/lib/skills/install";
import {
  createSkillPackageFetchContext,
  fetchSkillPackageFromUrl,
  verifySkillPackageIntegrity,
} from "@/api/lib/skills/skill-package";
import type { SkippedSkillFile } from "@/api/lib/skills/skill-package";

import {
  deduplicateSkillImportItems,
  SKILL_IMPORT_FAILURE_CODE,
  skillImportRequestBudget,
} from "./import-urls.logic";
import type { SkillImportFailureCode } from "./import-urls.logic";

const MAX_SKILL_IMPORTS = 20;
const SKILL_IMPORT_TIMEOUT_MS = 30_000;
// A selected GitHub skill can require one direct tree request per directory
// plus the selected directory, one recursive tree per resource root, and one
// raw request for SKILL.md plus every resource. A resource root must contain a
// resource to affect the package, so resourcesPerSkill also bounds those tree
// requests. Derive the batch cap from the accepted package limits so a valid
// shape is never rejected by an unrelated lower request ceiling; the shared
// deadline remains the runtime bound.
const SKILL_IMPORT_MAX_REQUESTS = skillImportRequestBudget({
  maxGithubDirectories: LIMITS.agentSkillGithubDirectoriesMax,
  maxImports: MAX_SKILL_IMPORTS,
  maxResourcesPerSkill: LIMITS.agentSkillResourcesPerSkill,
});
const CONTENT_HASH_PATTERN = "^[a-f0-9]{64}$";
const GITHUB_COMMIT_SHA_PATTERN = "^[a-f0-9]{40}$";
const importSkillScopeValues = [
  "team",
  "private",
] as const satisfies typeof AGENT_SKILL_SCOPES;

const importFailureCodeFromInstallError = (
  code: string | undefined,
): SkillImportFailureCode => {
  if (code === undefined) {
    return SKILL_IMPORT_FAILURE_CODE.INSTALL_FAILED;
  }

  switch (code) {
    case SKILL_INSTALL_ERROR_CODE.NAME_CONFLICT:
      return SKILL_IMPORT_FAILURE_CODE.NAME_CONFLICT;
    case SKILL_INSTALL_ERROR_CODE.TEAM_LIMIT_REACHED:
      return SKILL_IMPORT_FAILURE_CODE.TEAM_LIMIT_REACHED;
    case SKILL_INSTALL_ERROR_CODE.USER_LIMIT_REACHED:
      return SKILL_IMPORT_FAILURE_CODE.USER_LIMIT_REACHED;
    default:
      return SKILL_IMPORT_FAILURE_CODE.INSTALL_FAILED;
  }
};

export const importSkillsBodySchema = v.object({
  items: v.pipe(
    v.array(
      v.object({
        integrity: v.union([
          v.object({
            type: v.literal("content-hash"),
            value: v.pipe(
              v.string(),
              v.regex(new RegExp(CONTENT_HASH_PATTERN, "u")),
            ),
          }),
          v.object({
            entrypointHash: v.pipe(
              v.string(),
              v.regex(new RegExp(CONTENT_HASH_PATTERN, "u")),
            ),
            sourceUrl: v.pipe(v.string(), v.minLength(1), v.maxLength(2048)),
            type: v.literal("github-commit"),
            value: v.pipe(
              v.string(),
              v.regex(new RegExp(GITHUB_COMMIT_SHA_PATTERN, "u")),
            ),
          }),
        ]),
        sourceUrl: v.pipe(v.string(), v.minLength(1), v.maxLength(2048)),
      }),
    ),
    v.minLength(1),
    v.maxLength(MAX_SKILL_IMPORTS),
  ),
  scope: v.picklist(importSkillScopeValues),
});

const config = {
  contract: "patch",
  contentDelivery: {
    type: "none",
    reason: "Imports skills without delivering stored-file bytes.",
  },
  description:
    "Import one or more discovered skills from source URLs into the selected " +
    "scope. Each installed skill lists the package files it does not keep " +
    "(skippedFiles: path and reason).",
  permissions: { agentSkill: ["create"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  realtime: skillRealtimeUpdates,
  mcp: {
    type: "capability",
    reason: "agent_tool_authoring",
    consumesServices: false,
  },
  body: importSkillsBodySchema,
} satisfies HandlerConfig;

const importSkillsFromUrls = createSafeRootHandler(
  config,
  async function* ({
    body,
    memberRole,
    recordAuditEvent,
    safeDb,
    session,
    user,
  }) {
    const authorization = authorizeSkillInstallScope({
      memberRole,
      scope: body.scope,
    });
    if (Result.isError(authorization)) {
      return yield* Result.err(authorization.error);
    }

    const installed: {
      id: string;
      skippedFiles: SkippedSkillFile[];
      sourceUrl: string;
    }[] = [];
    const deduplicated = deduplicateSkillImportItems(body.items);
    const failed = [...deduplicated.failed];
    const { items } = deduplicated;
    const fetchContext = createSkillPackageFetchContext({
      permit: grantThirdPartyOutboundPermit(),
      limits: {
        deadlineAt:
          Temporal.Now.instant().epochMilliseconds + SKILL_IMPORT_TIMEOUT_MS,
        maxRequests: SKILL_IMPORT_MAX_REQUESTS,
      },
    });
    const importAt = async (index: number): Promise<void> => {
      const item = items.at(index);
      if (item === undefined) {
        return;
      }
      const { integrity, reportedSourceUrl, sourceUrl } = item;
      const parsed = await fetchSkillPackageFromUrl(sourceUrl, fetchContext);
      if (Result.isError(parsed)) {
        failed.push({
          code: SKILL_IMPORT_FAILURE_CODE.FETCH_FAILED,
          sourceUrl: reportedSourceUrl,
        });
        return importAt(index + 1);
      }

      const verification = verifySkillPackageIntegrity({
        integrity,
        parsed: parsed.value,
        sourceUrl,
      });
      if (Result.isError(verification)) {
        failed.push({
          code: SKILL_IMPORT_FAILURE_CODE.INTEGRITY_MISMATCH,
          sourceUrl: reportedSourceUrl,
        });
        return importAt(index + 1);
      }

      const result = await installSkill({
        memberRole,
        origin: "url",
        parsed: parsed.value,
        recordAuditEvent,
        safeDb,
        scope: body.scope,
        session,
        user,
      });
      if (result.isErr()) {
        failed.push({
          code: importFailureCodeFromInstallError(result.error.code),
          sourceUrl: reportedSourceUrl,
        });
        return importAt(index + 1);
      }
      installed.push({
        id: result.value.id,
        skippedFiles: parsed.value.skippedFiles,
        sourceUrl: reportedSourceUrl,
      });
      return importAt(index + 1);
    };

    await importAt(0);

    return Result.ok({ failed, installed });
  },
);

export default importSkillsFromUrls;
