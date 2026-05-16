import Elysia from "elysia";

import deleteSkill from "@/api/handlers/skills/delete";
import importSkillFromUrl from "@/api/handlers/skills/import-url";
import listSkills from "@/api/handlers/skills/list";
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
  .patch("/:skillId", updateSkill.handler, {
    body: updateSkill.config.body,
    invalidateQuery: true,
    params: updateSkill.config.params,
    permissions: updateSkill.config.permissions,
  })
  .delete("/:skillId", deleteSkill.handler, {
    invalidateQuery: true,
    params: deleteSkill.config.params,
    permissions: deleteSkill.config.permissions,
  });
