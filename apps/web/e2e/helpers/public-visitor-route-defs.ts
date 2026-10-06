import { panic } from "better-result";

import messages from "../../src/i18n/langs/en.json" with { type: "json" };

export const PACK_ID = "general-legal";
type CatalogueTemplate = { id: string; title: string };
type VisitorDestination = { path: string; heading: string; level: 1 | 2 };
export type VisitorRoute = {
  template: string;
  resolve: (
    template: CatalogueTemplate,
  ) => VisitorDestination | Promise<VisitorDestination>;
};

export const PUBLIC_VISITOR_ROUTE_DEFS = [
  {
    template: "/knowledge/templates/catalogue",
    resolve: () => ({
      path: "/knowledge/templates/catalogue",
      heading: messages.knowledge.sections.templates.title,
      level: 2,
    }),
  },
  {
    template: "/knowledge/templates/catalogue/$packId/$templateId",
    resolve: ({ id, title }) => ({
      path: `/knowledge/templates/catalogue/${PACK_ID}/${id}`,
      heading: title,
      level: 1,
    }),
  },
  {
    template: "/knowledge/tools/$entry",
    resolve: async () => {
      const { loadCatalogue } = await import("@stll/catalogue");
      const tool =
        loadCatalogue().find(({ slug }) => slug === "contract-review") ??
        panic("smoke catalogue entry missing");
      return {
        path: `/knowledge/tools/${tool.slug}`,
        heading: tool.displayName,
        level: 2,
      };
    },
  },
  {
    template: "/knowledge/tools/contribute",
    resolve: () => ({
      path: "/knowledge/tools/contribute",
      heading: messages.publicTools.contribute.title,
      level: 1,
    }),
  },
] as const satisfies readonly VisitorRoute[];
