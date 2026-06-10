import { Result } from "better-result";
import { t } from "elysia";

import { BLUEPRINT_IDS, getBlueprint, parseSkillFile } from "@stll/skills";

import { AGENT_SKILL_SCOPES } from "@/api/db/schema";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

import { authorizeSkillInstallScope, installSkill } from "./install";
import type { ParsedSkillPackage } from "./skill-package";
import { uniqueSlug } from "./slug";

const encoder = new TextEncoder();

const fromBlueprintBodySchema = t.Object({
  scope: t.UnionEnum(AGENT_SKILL_SCOPES),
  blueprintId: t.UnionEnum(BLUEPRINT_IDS),
});

const config = {
  permissions: { agentSkill: ["create"] },
  body: fromBlueprintBodySchema,
} satisfies HandlerConfig;

// Turn a bundled blueprint (a SKILL.md skeleton + placeholder resources) into
// the same ParsedSkillPackage shape that upload/import produce, so it can ride
// the shared installSkill primitive.
const buildParsedBlueprint = (
  blueprintId: string,
): ParsedSkillPackage | null => {
  const blueprint = getBlueprint(blueprintId);
  if (!blueprint) {
    return null;
  }

  const { body, metadata } = parseSkillFile(blueprint.source);
  const contentHash = new Bun.CryptoHasher("sha256")
    .update(body)
    .digest("hex")
    .slice(0, 64);

  return {
    body,
    compatibility: metadata.compatibility ?? null,
    contentHash,
    description: metadata.description,
    license: metadata.license ?? null,
    metadata: { blueprintId: blueprint.id },
    name: metadata.name,
    resources: blueprint.resources.map((resource) => ({
      content: resource.source,
      kind: resource.kind,
      path: resource.path,
      sizeBytes: encoder.encode(resource.source).byteLength,
    })),
    sourceUrl: null,
    version: metadata.version,
  };
};

const fromBlueprint = createSafeRootHandler(
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
      return Result.err(authorization.error);
    }

    const parsed = buildParsedBlueprint(body.blueprintId);
    if (!parsed) {
      return Result.err(
        new HandlerError({ status: 404, message: "Unknown blueprint" }),
      );
    }

    // Blueprints seed an editable draft the user customises before publishing,
    // so install as `authored` (fully editable), disabled, with a unique slug
    // so the same blueprint can be used more than once.
    const installed = yield* Result.await(
      installSkill({
        enabled: false,
        memberRole,
        origin: "authored",
        parsed,
        recordAuditEvent,
        safeDb,
        scope: body.scope,
        session,
        slug: uniqueSlug(parsed.name),
        user,
      }),
    );

    return Result.ok(installed);
  },
);

export default fromBlueprint;
