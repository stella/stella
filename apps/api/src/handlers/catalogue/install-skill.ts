import { Result } from "better-result";
import { t } from "elysia";

import { findCatalogueEntry } from "@stll/catalogue";

import { AGENT_SKILL_SCOPES } from "@/api/db/schema";
import { installSkill } from "@/api/handlers/skills/install";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

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

    const bodyHasher = new Bun.CryptoHasher("sha256");
    bodyHasher.update(entry.body);
    const contentHash = bodyHasher.digest("hex");

    const installResult = await installSkill({
      memberRole,
      origin: "bundled",
      parsed: {
        body: entry.body,
        compatibility: null,
        contentHash,
        description: entry.description,
        license: entry.license,
        metadata: {},
        name: entry.slug,
        resources: [],
        sourceUrl: null,
        version: null,
      },
      recordAuditEvent,
      safeDb,
      scope: body.scope ?? "team",
      session,
      user,
    });
    if (installResult.isErr()) {
      return yield* Result.err(installResult.error);
    }

    return Result.ok({ slug: entry.slug });
  },
);

export default installBundledSkill;
