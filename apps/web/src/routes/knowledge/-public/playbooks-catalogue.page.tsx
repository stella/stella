import { publicKnowledgeSource } from "@/features/knowledge/public/public-knowledge";
import { PlaybooksCataloguePending } from "@/routes/knowledge/-public/playbooks-catalogue.pending";
import { PublicPlaybooksCatalogue } from "@/routes/knowledge/-public/public-playbooks-catalogue";

/** The ready-made playbooks, the same for every visitor: the pending phase
 *  until the list has been read, so the page takes its shape once. */
export const PlaybooksCataloguePage = () => {
  const starters = publicKnowledgeSource.useCatalogueStarters();
  return starters.status === "loading" ? (
    <PlaybooksCataloguePending />
  ) : (
    <PublicPlaybooksCatalogue starters={starters} />
  );
};
