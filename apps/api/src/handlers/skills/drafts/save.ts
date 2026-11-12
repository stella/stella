import { Result } from "better-result";
import * as v from "valibot";

import { skillRealtimeUpdates } from "@/api/handlers/realtime-resource-sets";
import { authorizeSkillBinding } from "@/api/handlers/skills/skill-binding";
import { uniqueSlug } from "@/api/handlers/skills/slug";
import {
  findSkillDraftNames,
  unapprovedSkillDraftNames,
} from "@/api/lib/agent-skills/draft-names";
import {
  parseSkillDraft,
  skillDraftTexts,
} from "@/api/lib/agent-skills/draft-package";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { LIMITS } from "@/api/lib/limits";
import { installSkill } from "@/api/lib/skills/install";

/** SKILL.md is its body plus a short frontmatter. */
const MARKDOWN_MAX_CHARS = LIMITS.agentSkillBodyMaxChars + 4096;
const RESOURCES_MAX = 8;
const RESOURCE_PATH_MAX = 256;
const APPROVED_NAMES_MAX = 200;
const APPROVED_NAME_MAX_CHARS = 512;

const saveDraftBodySchema = v.object({
  markdown: v.pipe(v.string(), v.minLength(1), v.maxLength(MARKDOWN_MAX_CHARS)),
  resources: v.pipe(
    v.array(
      v.object({
        path: v.pipe(
          v.string(),
          v.minLength(1),
          v.maxLength(RESOURCE_PATH_MAX),
        ),
        content: v.pipe(
          v.string(),
          v.maxLength(LIMITS.agentSkillResourceModelContextMaxChars),
        ),
      }),
    ),
    v.maxLength(RESOURCES_MAX),
  ),
  approvedNames: v.pipe(
    v.array(v.pipe(v.string(), v.maxLength(APPROVED_NAME_MAX_CHARS))),
    v.maxLength(APPROVED_NAMES_MAX),
  ),
});

const config = {
  contract: "patch",
  contentDelivery: {
    type: "none",
    reason:
      "Stores a draft skill and returns its metadata rather than file bytes.",
  },
  permissions: { agentSkill: ["create"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  realtime: skillRealtimeUpdates,
  mcp: { type: "internal", reason: "assistant_chat" },
  body: saveDraftBodySchema,
} satisfies HandlerConfig;

/**
 * Store a reviewed skill draft as a private, disabled skill. Its text is
 * checked for names of people and organizations again, as it is now: a name
 * its author did not approve sends the draft back for review instead, since a
 * stored skill reaches everyone it is later shared with.
 */
const saveSkillDraft = createSafeRootHandler(
  config,
  async function* ({
    body,
    memberRole,
    recordAuditEvent,
    safeDb,
    scopedDb,
    session,
    user,
  }) {
    const { draft, parsed } = parseSkillDraft(body);
    const skill = yield* parsed;
    const names = yield* Result.await(
      findSkillDraftNames({
        organizationId: session.activeOrganizationId,
        scopedDb,
        texts: skillDraftTexts(draft),
        workspaceId: null,
      }),
    );
    const unapproved = unapprovedSkillDraftNames(names, body.approvedNames);
    if (unapproved.length > 0) {
      return Result.ok({ type: "review" as const, names: unapproved });
    }

    const binding = { boundClientId: null, boundWorkspaceId: null };
    yield* Result.await(
      authorizeSkillBinding({ binding, memberRole, safeDb, scope: "private" }),
    );
    const installed = yield* Result.await(
      installSkill({
        binding,
        enabled: false,
        memberRole,
        origin: "authored",
        parsed: skill,
        recordAuditEvent,
        safeDb,
        scope: "private",
        session,
        slug: uniqueSlug(skill.name),
        user,
      }),
    );
    return Result.ok({ type: "saved" as const, skill: installed });
  },
);

export default saveSkillDraft;
