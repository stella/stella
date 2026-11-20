import { PlaybooksPagePending } from "@/features/knowledge/views/playbooks/playbooks-page-shape";
import { framePendingView } from "@/routes/-pending-view.logic";

/** The ready-made playbooks while they load: the playbooks page's shape. */
export const PlaybooksCataloguePending = framePendingView(() => (
  <PlaybooksPagePending page="catalogue" />
));
