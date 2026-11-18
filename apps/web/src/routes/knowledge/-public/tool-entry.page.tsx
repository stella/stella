import { getRouteApi } from "@tanstack/react-router";

import { getAnalytics } from "@/lib/analytics/provider";
import { PublicToolDetail } from "@/routes/knowledge/-public/public-tool-detail";
import { ToolEntryShell } from "@/routes/knowledge/-public/tool-entry.pending";

const toolEntryRouteApi = getRouteApi("/knowledge/tools_/$entry");

/** A published tool on its own page, the same for every visitor. */
export const ToolEntryPage = () => {
  const { entry, markdown } = toolEntryRouteApi.useLoaderData();
  const installIntent = toolEntryRouteApi.useSearch({
    select: (s) => s.install === "1",
  });
  const navigate = toolEntryRouteApi.useNavigate();

  return (
    <ToolEntryShell>
      <PublicToolDetail
        entry={entry}
        installIntent={installIntent}
        markdown={markdown}
        onClearInstallIntent={() => {
          navigate({ replace: true, search: {} }).catch((error: unknown) => {
            getAnalytics().captureError(error, {
              fingerprintKey: "ToolEntryPage:failure",
              scope: { type: "handler", handlerId: "ToolEntryPage:failure" },
            });
          });
        }}
      />
    </ToolEntryShell>
  );
};
