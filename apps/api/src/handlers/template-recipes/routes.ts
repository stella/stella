import Elysia from "elysia";

import createTemplateRecipe from "@/api/handlers/template-recipes/create";
import deleteTemplateRecipe from "@/api/handlers/template-recipes/delete";
import listTemplateRecipes from "@/api/handlers/template-recipes/list";
import { authMacro, permissionMacro } from "@/api/lib/auth";

export const templateRecipesRoute = new Elysia({
  prefix: "/template-recipes",
})
  .use(authMacro)
  .use(permissionMacro)
  .guard({ validateAuth: true })
  .get("/", listTemplateRecipes.handler, {
    permissions: listTemplateRecipes.config.permissions,
    accountAccess: listTemplateRecipes.config.accountAccess,
  })
  .put("/", createTemplateRecipe.handler, {
    body: createTemplateRecipe.config.body,
    permissions: createTemplateRecipe.config.permissions,
    accountAccess: createTemplateRecipe.config.accountAccess,
  })
  .delete("/:recipeId", deleteTemplateRecipe.handler, {
    params: deleteTemplateRecipe.config.params,
    permissions: deleteTemplateRecipe.config.permissions,
    accountAccess: deleteTemplateRecipe.config.accountAccess,
  });
