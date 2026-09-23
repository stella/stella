import { Result } from "better-result";
import { and, eq } from "drizzle-orm";

import { agentSkillResources } from "@/api/db/schema";
import { loadManagedSkill } from "@/api/handlers/skills/managed-skill";
import type { LoadManagedSkillOptions } from "@/api/handlers/skills/managed-skill";
import { requireEditableSkillOrigin } from "@/api/lib/agent-skills/origin";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";

type LoadSkillForNewResourceOptions = Omit<
  LoadManagedSkillOptions,
  "action"
> & { path: string };

/**
 * Load an editable skill the caller manages that can take one more resource
 * file at `path`: under the per-skill file limit, with the path still free.
 */
export const loadSkillForNewResource = async ({
  path,
  ...options
}: LoadSkillForNewResourceOptions) =>
  await Result.gen(async function* () {
    const { safeDb, skillId } = options;
    const skill = yield* Result.await(
      loadManagedSkill({ ...options, action: "edit" }),
    );
    yield* requireEditableSkillOrigin(skill.origin);

    const existingCount = yield* Result.await(
      safeDb((tx) =>
        tx.$count(
          agentSkillResources,
          eq(agentSkillResources.skillId, skillId),
        ),
      ),
    );
    if (existingCount >= LIMITS.agentSkillResourcesPerSkill) {
      return Result.err(
        new HandlerError({
          status: 400,
          message: "Skill has reached the maximum number of files",
        }),
      );
    }

    const duplicateRows = yield* Result.await(
      safeDb((tx) =>
        tx
          .select({ id: agentSkillResources.id })
          .from(agentSkillResources)
          .where(
            and(
              eq(agentSkillResources.skillId, skillId),
              eq(agentSkillResources.path, path),
            ),
          )
          .limit(1),
      ),
    );
    if (duplicateRows.length > 0) {
      return Result.err(
        new HandlerError({ status: 409, message: "File already exists" }),
      );
    }

    return Result.ok(skill);
  });
