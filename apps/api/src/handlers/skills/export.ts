import { Result } from "better-result";
import { and, asc, eq, sum } from "drizzle-orm";
import * as v from "valibot";

import {
  SKILL_EXPORT_TOO_LARGE_CODE,
  SKILL_PACKAGE_SKILL_NOT_FOUND_CODE,
} from "@stll/api-contract";
import { createZipStream } from "@stll/docx-core/zip/stream";
import { SKILL_FILE_NAME, SKILL_PACKAGE_LIMITS } from "@stll/skills/format";

import { agentSkillResources, agentSkills } from "@/api/db/schema";
import {
  renderSkillFile,
  skillFileName,
} from "@/api/lib/agent-skills/skill-file";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { resourceIdSchema } from "@/api/lib/custom-schema";
import { readBounded } from "@/api/lib/db/read-bounded";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { sanitizeFilename } from "@/api/lib/sanitize-filename";
import { secureDocumentResponse } from "@/api/lib/secure-document-response";

const config = {
  contract: "patch",
  description:
    "Download one agent skill as a standard Agent Skills archive: a ZIP " +
    "with one folder named after the skill, holding SKILL.md (frontmatter " +
    "and instructions) and every resource file at its path, ready for any " +
    "host that reads Agent Skills. Readable by whoever may read the skill " +
    "(skills.get); the download is recorded in the audit trail.",
  permissions: { chat: ["create"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  contentDelivery: { type: "audited" },
  access: "read",
  mcp: {
    type: "capability",
    readClass: "tenant",
    reason: "agent_tool_authoring",
    consumesServices: false,
  },
  transport: {
    type: "file-response",
    response: { mediaTypes: ["application/zip"] },
    alternative: {
      type: "partial",
      via: ["skills.get"],
      limitation:
        "returns the skill as JSON (instructions and each resource) rather than a SKILL.md package another host can install",
    },
  },
  params: v.object({ skillId: resourceIdSchema("agentSkill") }),
} satisfies HandlerConfig;

const exportSkill = createSafeRootHandler(
  config,
  async function* ({ params, recordAuditEvent, safeDb, session }) {
    const rows = yield* Result.await(
      safeDb((tx) =>
        tx
          .select({
            body: agentSkills.body,
            compatibility: agentSkills.compatibility,
            description: agentSkills.description,
            invocation: agentSkills.invocation,
            license: agentSkills.license,
            metadata: agentSkills.metadata,
            name: agentSkills.name,
            version: agentSkills.version,
          })
          .from(agentSkills)
          .where(
            and(
              eq(agentSkills.id, params.skillId),
              eq(agentSkills.organizationId, session.activeOrganizationId),
            ),
          )
          .limit(1),
      ),
    );
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
    const [size] = yield* Result.await(
      safeDb((tx) =>
        tx
          .select({ bytes: sum(agentSkillResources.sizeBytes).mapWith(Number) })
          .from(agentSkillResources)
          .where(eq(agentSkillResources.skillId, params.skillId)),
      ),
    );
    // The archive is built in memory; an upload could not hold more.
    if ((size?.bytes ?? 0) > SKILL_PACKAGE_LIMITS.archiveUncompressedMaxBytes) {
      return Result.err(
        new HandlerError({
          code: SKILL_EXPORT_TOO_LARGE_CODE,
          status: 413,
          message: "Skill is too large to download as one archive",
        }),
      );
    }
    const read = yield* Result.await(
      safeDb(
        async (tx) =>
          await readBounded(
            tx
              .select({
                content: agentSkillResources.content,
                path: agentSkillResources.path,
              })
              .from(agentSkillResources)
              .where(eq(agentSkillResources.skillId, params.skillId))
              .orderBy(asc(agentSkillResources.path)),
            SKILL_PACKAGE_LIMITS.resourcesPerSkillMax,
          ),
      ),
    );
    // A skill cannot be saved with more files; an archive must not drop any.
    if (read.type === "overflow") {
      return Result.err(
        new HandlerError({
          code: SKILL_EXPORT_TOO_LARGE_CODE,
          status: 413,
          message: "Skill has too many files to download as one archive",
        }),
      );
    }
    const resources = read.rows;
    yield* Result.await(
      safeDb(
        async (tx) =>
          await recordAuditEvent(tx, {
            action: AUDIT_ACTION.DOWNLOAD,
            resourceType: AUDIT_RESOURCE_TYPE.AGENT_SKILL,
            resourceId: params.skillId,
            metadata: { archiveType: "zip", resourceCount: resources.length },
          }),
      ),
    );
    const folder = skillFileName(skill.name);
    return Result.ok(
      secureDocumentResponse({
        body: createZipStream([
          {
            path: `${folder}/${SKILL_FILE_NAME}`,
            data: renderSkillFile(skill),
          },
          ...resources.map(({ content, path }) => ({
            path: `${folder}/${path}`,
            data: content,
          })),
        ]),
        contentType: "application/zip",
        disposition: "attachment",
        fileName: sanitizeFilename(`${folder}.zip`),
      }),
    );
  },
);

export default exportSkill;
