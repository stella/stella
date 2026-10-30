import { panic, Result } from "better-result";
import * as v from "valibot";

import {
  BLUEPRINT_IDS,
  getBlueprint,
  hashSkillPackage,
  validateSkillPackage,
} from "@stll/skills";

import { AGENT_SKILL_SCOPES } from "@/api/db/schema";
import { skillRealtimeUpdates } from "@/api/handlers/realtime-resource-sets";
import {
  authorizeSkillBinding,
  skillBindingBodyFields,
} from "@/api/handlers/skills/skill-binding";
import { skillRequirableToolNames } from "@/api/lib/agent-skills/required-tools-validation";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { installSkill } from "@/api/lib/skills/install";
import type { ParsedSkillPackage } from "@/api/lib/skills/skill-package";

import { uniqueSlug } from "../slug";

const encoder = new TextEncoder();

const fromBlueprintBodySchema = v.object({
  scope: v.picklist(AGENT_SKILL_SCOPES),
  blueprintId: v.picklist(BLUEPRINT_IDS),
  ...skillBindingBodyFields,
});

const config = {
  contract: "patch",
  contentDelivery: {
    type: "none",
    reason:
      "Stores a draft skill and returns its metadata rather than file bytes.",
  },
  description:
    "Create an editable draft skill from one of the bundled blueprints, a " +
    "SKILL.md skeleton with placeholder resource files. The draft is " +
    "installed disabled and under a fresh slug, so the same blueprint can be " +
    "used more than once, and stays fully editable afterwards. Team scope " +
    "requires admin or owner, unless the draft is bound to a matter " +
    "(`boundWorkspaceId`) the caller reaches; `boundClientId` binds it to one " +
    "client (admins and owners only). A bound skill is visible and usable " +
    "only there, and the binding cannot change later.",
  permissions: { agentSkill: ["create"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  realtime: skillRealtimeUpdates,
  mcp: {
    type: "capability",
    reason: "agent_tool_authoring",
    consumesServices: false,
  },
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

  const validated = validateSkillPackage({
    files: [
      { content: blueprint.source, path: "SKILL.md" },
      ...blueprint.resources.map((resource) => ({
        content: resource.source,
        path: resource.path,
      })),
    ],
    tools: { known: skillRequirableToolNames(), type: "check" },
  });
  if (validated.isErr()) {
    return panic(
      `Blueprint skill package is invalid: ${JSON.stringify(validated.error)}`,
    );
  }
  const { body, metadata, resources, source } = validated.value;

  return {
    body,
    compatibility: metadata.compatibility ?? null,
    description: metadata.description,
    entrypointHash: hashSkillPackage({ resources, source }),
    invocation: metadata.invocation,
    license: metadata.license ?? null,
    metadata: { ...metadata.metadata, blueprintId: blueprint.id },
    name: metadata.name,
    resources: resources.map((resource) => ({
      ...resource,
      sizeBytes: encoder.encode(resource.content).byteLength,
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
    const binding = {
      boundClientId: body.boundClientId ?? null,
      boundWorkspaceId: body.boundWorkspaceId ?? null,
    };
    yield* Result.await(
      authorizeSkillBinding({
        binding,
        memberRole,
        safeDb,
        scope: body.scope,
      }),
    );

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
        binding,
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
