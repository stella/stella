import { Result } from "better-result";
import { t } from "elysia";

import { findCatalogueEntry } from "@stll/catalogue";

import { AGENT_SKILL_SCOPES } from "@/api/db/schema";
import { installSkill } from "@/api/handlers/skills/install";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

import {
  toParsedBundledSkillPackage,
  toParsedBundledSkillResources,
} from "./bundled-skill-resources";

const installSkillBody = t.Object({
  slug: t.String({ minLength: 1, maxLength: 64 }),
  scope: t.Optional(t.UnionEnum(AGENT_SKILL_SCOPES)),
});

const config = {
  permissions: { organizationSettings: ["update"] },
  body: installSkillBody,
} satisfies HandlerConfig;

const installBundledSkill = createSafeRootHandler(
  config,
  async function* ({
    body,
    memberRole,
    recordAuditEvent,
    safeDb,
    session,
    user,
  }) {
    const entry = findCatalogueEntry("skill", body.slug);
    if (!entry || entry.kind !== "skill" || entry.body === null) {
      return Result.err(
        new HandlerError({
          status: 404,
          message: `Bundled skill not found in catalogue: ${body.slug}`,
        }),
      );
    }

    const resourcesResult = toParsedBundledSkillResources(entry.resourceFiles);
    if (Result.isError(resourcesResult)) {
      return Result.err(resourcesResult.error);
    }

    const packageResult = toParsedBundledSkillPackage({
      expectedSlug: entry.slug,
      resources: resourcesResult.value,
      source: entry.body,
    });
    if (Result.isError(packageResult)) {
      return Result.err(packageResult.error);
    }

    const installResult = await installSkill({
      memberRole,
      origin: "bundled",
      parsed: packageResult.value,
      recordAuditEvent,
      safeDb,
      scope: body.scope ?? "team",
      session,
      user,
    });
    if (installResult.isErr()) {
      return yield* Result.err(installResult.error);
    }

    return Result.ok({ slug: packageResult.value.name });
  },
);

export default installBundledSkill;
