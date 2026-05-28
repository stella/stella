import Elysia from "elysia";

import deleteSkill from "@/api/handlers/skills/delete";
import generateSkillDraft from "@/api/handlers/skills/generate-draft";
import getSkill from "@/api/handlers/skills/get";
import importSkillFromUrl from "@/api/handlers/skills/import-url";
import listSkills from "@/api/handlers/skills/list";
import createSkillResource from "@/api/handlers/skills/resources/create";
import deleteSkillResource from "@/api/handlers/skills/resources/delete";
import renameSkillResource from "@/api/handlers/skills/resources/rename";
import rewriteSkillResource from "@/api/handlers/skills/resources/rewrite";
import updateSkillResource from "@/api/handlers/skills/resources/update";
import updateSkill from "@/api/handlers/skills/update";
import uploadSkill from "@/api/handlers/skills/upload";
import { authMacro, permissionMacro } from "@/api/lib/auth";
import { invalidateQuery } from "@/api/lib/invalidate-query-macro";

export const skillsRoute = new Elysia({ prefix: "/skills" })
  .use(authMacro)
  .use(permissionMacro)
  .use(invalidateQuery)
  .guard({ validateAuth: true })
  .get("/", listSkills.handler, {
    permissions: listSkills.config.permissions,
    query: listSkills.config.query,
  })
  .get("/:skillId", getSkill.handler, {
    params: getSkill.config.params,
    permissions: getSkill.config.permissions,
  })
  .post("/upload", uploadSkill.handler, {
    body: uploadSkill.config.body,
    invalidateQuery: true,
    permissions: uploadSkill.config.permissions,
  })
  .post("/import-url", importSkillFromUrl.handler, {
    body: importSkillFromUrl.config.body,
    invalidateQuery: true,
    permissions: importSkillFromUrl.config.permissions,
  })
  .post("/generate-draft", generateSkillDraft.handler, {
    body: generateSkillDraft.config.body,
    permissions: generateSkillDraft.config.permissions,
  })
  .patch("/:skillId", updateSkill.handler, {
    body: updateSkill.config.body,
    invalidateQuery: true,
    params: updateSkill.config.params,
    permissions: updateSkill.config.permissions,
  })
  .patch("/:skillId/resources", updateSkillResource.handler, {
    body: updateSkillResource.config.body,
    invalidateQuery: true,
    params: updateSkillResource.config.params,
    permissions: updateSkillResource.config.permissions,
  })
  .post("/:skillId/resources", createSkillResource.handler, {
    body: createSkillResource.config.body,
    invalidateQuery: true,
    params: createSkillResource.config.params,
    permissions: createSkillResource.config.permissions,
  })
  .delete("/:skillId/resources", deleteSkillResource.handler, {
    body: deleteSkillResource.config.body,
    invalidateQuery: true,
    params: deleteSkillResource.config.params,
    permissions: deleteSkillResource.config.permissions,
  })
  .post("/:skillId/resources/rename", renameSkillResource.handler, {
    body: renameSkillResource.config.body,
    invalidateQuery: true,
    params: renameSkillResource.config.params,
    permissions: renameSkillResource.config.permissions,
  })
  .post("/:skillId/resources/rewrite", rewriteSkillResource.handler, {
    body: rewriteSkillResource.config.body,
    params: rewriteSkillResource.config.params,
    permissions: rewriteSkillResource.config.permissions,
  })
  .delete("/:skillId", deleteSkill.handler, {
    invalidateQuery: true,
    params: deleteSkill.config.params,
    permissions: deleteSkill.config.permissions,
  });
