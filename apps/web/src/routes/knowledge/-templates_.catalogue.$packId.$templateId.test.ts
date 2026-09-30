import { QueryClient } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRouteWithContext,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { expect, test } from "bun:test";

import { publicKnowledgeKeys } from "@/features/knowledge/public/public-knowledge-queries";
import { Route as TemplateDetailRoute } from "@/routes/knowledge/templates_.catalogue.$packId.$templateId";

test("an empty public template catalogue makes a detail URL not found", async () => {
  const queryClient = new QueryClient();
  queryClient.setQueryData(publicKnowledgeKeys.templates.catalogue(), []);

  const rootRoute = createRootRouteWithContext<{
    queryClient: QueryClient;
  }>()();
  const detailRoute = createRoute({
    getParentRoute: () => rootRoute,
    loader: TemplateDetailRoute.options.loader,
    path: "/knowledge/templates/catalogue/$packId/$templateId",
  });
  const router = createRouter({
    context: { queryClient },
    history: createMemoryHistory({
      initialEntries: [
        "/knowledge/templates/catalogue/general-legal/missing-template",
      ],
    }),
    routeTree: rootRoute.addChildren([detailRoute]),
  });

  await router.load();

  expect(router.state.matches.at(-1)?.status).toBe("notFound");
});
