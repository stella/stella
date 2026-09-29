import { createFileRoute } from "@tanstack/react-router";

import {
  ContributePage,
  createToolContributeHead,
} from "@/routes/knowledge/-public/tool-contribute-page";

// Goes once the Knowledge flag is permanent: the page then lives only at
// `/knowledge/tools/contribute`.
export const Route = createFileRoute("/tools/contribute")({
  head: createToolContributeHead,
  component: ContributePage,
});
