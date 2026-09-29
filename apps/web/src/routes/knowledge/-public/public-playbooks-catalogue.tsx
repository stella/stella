import { useRequireAccount } from "@/components/auth/use-require-account";
import { publicKnowledgeSource } from "@/features/knowledge/public/public-knowledge";
import { PlaybooksPageView } from "@/features/knowledge/views/playbooks/playbooks-page-view";
import { starterIntentHref } from "@/lib/knowledge/catalogue-intent";

const noop = () => undefined;

/**
 * The playbooks page for a visitor without an account: the ready-made
 * playbooks from the catalogue, the same cards a library shows. Starting from
 * one asks for an account and comes back to this page with the choice named,
 * where the member's page confirms it.
 */
export const PublicPlaybooksCatalogue = () => {
  const starters = publicKnowledgeSource.useCatalogueStarters();
  const ensureAccount = useRequireAccount();

  return (
    <PlaybooksPageView
      actions={{
        startFrom: (starter) => {
          ensureAccount({ returnTo: starterIntentHref(starter.starterId) });
        },
        open: noop,
        loadMore: noop,
        refresh: noop,
      }}
      source={{ starters }}
    />
  );
};
