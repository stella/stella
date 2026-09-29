import { lazy, Suspense } from "react";

import { ClientOnly, useNavigate } from "@tanstack/react-router";
import { useTranslations } from "use-intl";

import type { LoadedCatalogueEntry } from "@stll/catalogue";

import { nativeToolLabelKey } from "@/components/catalogue/native-tool-label";
import { toKnowledgeToolDetail } from "@/features/knowledge/public/public-tools";
import { ToolDetailPanelView } from "@/features/knowledge/views/tools/tool-detail-panel-view";
import { detached } from "@/lib/detached";
import {
  DownloadAffordance,
  InstallButtonPlaceholder,
  ToolContent,
} from "@/routes/knowledge/-public/public-tool-content";

const AddToStella = lazy(async () => ({
  default: (await import("@/routes/tools/-components/add-to-stella"))
    .AddToStella,
}));

type PublicToolDetailProps = {
  entry: LoadedCatalogueEntry;
  markdown: string | null;
  installIntent: boolean;
  onClearInstallIntent: () => void;
};

/** A published tool on its own page: the shared detail with its full
 *  documentation, and adding it to a workspace. The same for every visitor. */
export function PublicToolDetail({
  entry,
  markdown,
  installIntent,
  onClearInstallIntent,
}: PublicToolDetailProps) {
  const t = useTranslations();
  const navigate = useNavigate();
  const labelKey = nativeToolLabelKey({ slug: entry.slug, kind: entry.kind });
  const displayName = labelKey ? t(labelKey) : entry.displayName;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ToolDetailPanelView
        body={<ToolContent entry={entry} markdown={markdown} />}
        footer={
          <>
            <ClientOnly fallback={<InstallButtonPlaceholder />}>
              <Suspense fallback={<InstallButtonPlaceholder />}>
                <AddToStella
                  displayName={displayName}
                  entry={entry}
                  installIntent={installIntent}
                  onClearInstallIntent={onClearInstallIntent}
                />
              </Suspense>
            </ClientOnly>
            <DownloadAffordance entry={entry} />
          </>
        }
        onClose={() => {
          detached(
            navigate({ to: "/knowledge/tools" }),
            "public-tool-detail.close",
          );
        }}
        tool={toKnowledgeToolDetail(entry)}
      />
    </div>
  );
}
