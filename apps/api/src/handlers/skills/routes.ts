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
  .get("/", listSkills.handler)
  .post("/upload", uploadSkill.handler, {
    body: uploadSkill.config.body,
    invalidateQuery: true,
  })
  .post("/import-url", importSkillFromUrl.handler, {
    body: importSkillFromUrl.config.body,
    invalidateQuery: true,
  })
  .patch("/:skillId", updateSkill.handler, {
    params: updateSkill.config.params,
    body: updateSkill.config.body,
    invalidateQuery: true,
  })
  .delete("/:skillId", deleteSkill.handler, {
    params: deleteSkill.config.params,
    invalidateQuery: true,
  });
