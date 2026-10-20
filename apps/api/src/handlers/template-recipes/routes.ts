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
  .get(
    "/",
    {
      permissions: listTemplateRecipes.config.permissions,
    },
    listTemplateRecipes.handler,
  )
  .put(
    "/",
    {
      body: createTemplateRecipe.config.body,
      permissions: createTemplateRecipe.config.permissions,
    },
    createTemplateRecipe.handler,
  )
  .delete(
    "/:recipeId",
    {
      params: deleteTemplateRecipe.config.params,
      permissions: deleteTemplateRecipe.config.permissions,
    },
    deleteTemplateRecipe.handler,
  );
