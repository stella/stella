import { publicToolsContributePath } from "@/lib/knowledge/public-tools-path";
import { pageTitle } from "@/lib/page-title";
import { createPublicToolsHead } from "@/lib/public-tools-seo";

/**
 * The contribute page's head, at the tools' current address. Kept apart from
 * the page so the route's head does not load the form with it.
 */
export const createToolContributeHead = () =>
  createPublicToolsHead({
    description: "",
    path: publicToolsContributePath(),
    title: pageTitle("publicTools.contribute.title"),
    type: "article",
  });
