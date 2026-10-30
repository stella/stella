import createTemplateRecipe from "@/api/handlers/template-recipes/create";
import deleteTemplateRecipe from "@/api/handlers/template-recipes/delete";
import listTemplateRecipes from "@/api/handlers/template-recipes/list";
import { routes } from "@/api/http/route";

export const templateRecipesRoute = routes(
  {
    "/": { GET: listTemplateRecipes, PUT: createTemplateRecipe },
    "/:recipeId": { DELETE: deleteTemplateRecipe },
  },
  { prefix: "/template-recipes" },
);
