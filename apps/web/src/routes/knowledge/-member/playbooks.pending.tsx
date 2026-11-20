import { PlaybooksPagePending } from "@/features/knowledge/views/playbooks/playbooks-page-shape";
import { framePendingView } from "@/routes/-pending-view.logic";

/** The organization's playbooks while they load. */
export const PlaybooksPending = framePendingView(() => (
  <PlaybooksPagePending />
));
