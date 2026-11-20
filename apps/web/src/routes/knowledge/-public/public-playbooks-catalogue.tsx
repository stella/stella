import { useRequireAccount } from "@/components/auth/use-require-account";
import type { KnowledgeSource } from "@/features/knowledge/views/knowledge-seam";
import { PlaybooksPageView } from "@/features/knowledge/views/playbooks/playbooks-page-view";
import { starterIntentHref } from "@/lib/knowledge/catalogue-intent";

const noop = () => undefined;

/**
 * The playbooks page for a visitor without an account: the ready-made
 * playbooks from the catalogue, the same cards a library shows. Starting from
 * one asks for an account and comes back to the organization's playbooks with
 * the choice named, where the member's page confirms it.
 */
export const PublicPlaybooksCatalogue = ({
  starters,
}: {
  /** The catalogue's ready-made playbooks, read by the page. */
  starters: KnowledgeSource<"playbooks">["starters"];
}) => {
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
