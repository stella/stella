import type { CatalogueRowDisplay } from "@/components/catalogue/catalogue-row";

/**
 * A catalogue tool as the shared views render it, whichever source supplied
 * it. Whether an organization is recommended the tool is known only where
 * there is an organization; elsewhere it is absent and nothing is ranked.
 */
export type KnowledgeTool = CatalogueRowDisplay & {
  tags: readonly string[];
  isRecommendedForOrg?: boolean | undefined;
};

/** A connected server's settings, shown once the tool is in use. */
type KnowledgeToolConnection = {
  url: string;
  authType: "none" | "bearer" | "oauth";
  serverVersion?: string | null | undefined;
};

/** Everything the tool detail shows. */
export type KnowledgeToolDetail = KnowledgeTool & {
  authorUrl?: string | undefined;
  homepage?: string | undefined;
  /** `null` when unknown; never guessed. */
  license: string | null;
  /** Present only where the tool is connected for the viewer. */
  connection?: KnowledgeToolConnection | undefined;
};

/** What the tools catalogue renders. The route's adapter fills it. */
export type ToolsSource<TTool extends KnowledgeTool = KnowledgeTool> = {
  entries: readonly TTool[];
};
