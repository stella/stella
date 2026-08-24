import Elysia from "elysia";

import { RESOURCE_TYPE } from "@stll/api-contract";

import createSkill from "@/api/handlers/skills/create";
import deleteSkill from "@/api/handlers/skills/delete";
import discoverSkillUrl from "@/api/handlers/skills/discover";
import fromBlueprint from "@/api/handlers/skills/from-blueprint";
import generateSkillDraft from "@/api/handlers/skills/generate-draft";
import getSkill from "@/api/handlers/skills/get";
import importSkillsFromUrls from "@/api/handlers/skills/import";
import importSkillFromUrl from "@/api/handlers/skills/import-url";
import listSkills from "@/api/handlers/skills/list";
import listSkillCommands from "@/api/handlers/skills/list-commands";
import createSkillResource from "@/api/handlers/skills/resources/create";
import deleteSkillResource from "@/api/handlers/skills/resources/delete";
import renameSkillResource from "@/api/handlers/skills/resources/rename";
import rewriteSkillResource from "@/api/handlers/skills/resources/rewrite";
import updateSkillResource from "@/api/handlers/skills/resources/update";
import uploadSkillResource from "@/api/handlers/skills/resources/upload";
import seedSkills from "@/api/handlers/skills/seed";
import {
  isSkillSourceRateLimitedRequest,
  skillSourceRateLimitBinding,
} from "@/api/handlers/skills/source-rate-limit";
import updateSkill from "@/api/handlers/skills/update";
import uploadSkill from "@/api/handlers/skills/upload";
import { authMacro, permissionMacro } from "@/api/lib/auth";
import { API_RATE_LIMITS } from "@/api/lib/limits";
import { rateLimit } from "@/api/lib/rate-limit/rate-limit";
import {
  organizationResourceSetUpdates,
  resourceRealtime,
} from "@/api/lib/resource-realtime-macro";

const skillRealtimeUpdates = organizationResourceSetUpdates([
  RESOURCE_TYPE.AGENT_SKILL,
  RESOURCE_TYPE.AGENT_SKILL_RESOURCE,
]);

export const skillsRoute = new Elysia({ prefix: "/skills" })
  .use(authMacro)
  .use(permissionMacro)
  .use(resourceRealtime)
  .use(
    rateLimit({
      duration: API_RATE_LIMITS.skillSource.duration,
      max: API_RATE_LIMITS.skillSource.max,
      ...skillSourceRateLimitBinding,
      skip: (request) => !isSkillSourceRateLimitedRequest(request),
    }),
  )
  .guard({ validateAuth: true })
  .get("/", listSkills.handler, {
    permissions: listSkills.config.permissions,
    query: listSkills.config.query,
  })
  .get("/commands", listSkillCommands.handler, {
    permissions: listSkillCommands.config.permissions,
  })
  .get("/:skillId", getSkill.handler, {
    params: getSkill.config.params,
    permissions: getSkill.config.permissions,
  })
  .post("/", createSkill.handler, {
    body: createSkill.config.body,
    resourceSetUpdated: skillRealtimeUpdates,
    permissions: createSkill.config.permissions,
  })
  .post("/seed", seedSkills.handler, {
    resourceSetUpdated: skillRealtimeUpdates,
    permissions: seedSkills.config.permissions,
  })
  .post("/from-blueprint", fromBlueprint.handler, {
    body: fromBlueprint.config.body,
    resourceSetUpdated: skillRealtimeUpdates,
    permissions: fromBlueprint.config.permissions,
  })
  .post("/upload", uploadSkill.handler, {
    body: uploadSkill.config.body,
    resourceSetUpdated: skillRealtimeUpdates,
    permissions: uploadSkill.config.permissions,
  })
  .post("/import-url", importSkillFromUrl.handler, {
    body: importSkillFromUrl.config.body,
    resourceSetUpdated: skillRealtimeUpdates,
    permissions: importSkillFromUrl.config.permissions,
  })
  .post("/discover-url", discoverSkillUrl.handler, {
    body: discoverSkillUrl.config.body,
    permissions: discoverSkillUrl.config.permissions,
  })
  .post("/import-urls", importSkillsFromUrls.handler, {
    body: importSkillsFromUrls.config.body,
    resourceSetUpdated: skillRealtimeUpdates,
    permissions: importSkillsFromUrls.config.permissions,
  })
  .post("/generate-draft", generateSkillDraft.handler, {
    body: generateSkillDraft.config.body,
    permissions: generateSkillDraft.config.permissions,
  })
  .patch("/:skillId", updateSkill.handler, {
    body: updateSkill.config.body,
    resourceSetUpdated: skillRealtimeUpdates,
    params: updateSkill.config.params,
    permissions: updateSkill.config.permissions,
  })
  .patch("/:skillId/resources", updateSkillResource.handler, {
    body: updateSkillResource.config.body,
    resourceSetUpdated: skillRealtimeUpdates,
    params: updateSkillResource.config.params,
    permissions: updateSkillResource.config.permissions,
  })
  .post("/:skillId/resources", createSkillResource.handler, {
    body: createSkillResource.config.body,
    resourceSetUpdated: skillRealtimeUpdates,
    params: createSkillResource.config.params,
    permissions: createSkillResource.config.permissions,
  })
  .delete("/:skillId/resources", deleteSkillResource.handler, {
    body: deleteSkillResource.config.body,
    resourceSetUpdated: skillRealtimeUpdates,
    params: deleteSkillResource.config.params,
    permissions: deleteSkillResource.config.permissions,
  })
  .post("/:skillId/resources/rename", renameSkillResource.handler, {
    body: renameSkillResource.config.body,
    resourceSetUpdated: skillRealtimeUpdates,
    params: renameSkillResource.config.params,
    permissions: renameSkillResource.config.permissions,
  })
  .post("/:skillId/resources/upload", uploadSkillResource.handler, {
    body: uploadSkillResource.config.body,
    resourceSetUpdated: skillRealtimeUpdates,
    params: uploadSkillResource.config.params,
    permissions: uploadSkillResource.config.permissions,
  })
  .post("/:skillId/resources/rewrite", rewriteSkillResource.handler, {
    body: rewriteSkillResource.config.body,
    params: rewriteSkillResource.config.params,
    permissions: rewriteSkillResource.config.permissions,
  })
  .delete("/:skillId", deleteSkill.handler, {
    resourceSetUpdated: skillRealtimeUpdates,
    params: deleteSkill.config.params,
    permissions: deleteSkill.config.permissions,
  });
