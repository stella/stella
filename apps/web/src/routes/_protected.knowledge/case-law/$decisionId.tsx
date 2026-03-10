import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useTranslations } from "use-intl";

import { DecisionText } from "@/routes/_protected.knowledge/case-law/-components/case-viewer/decision-text";
import { MetadataPanel } from "@/routes/_protected.knowledge/case-law/-components/case-viewer/metadata-panel";
import { SectionToc } from "@/routes/_protected.knowledge/case-law/-components/case-viewer/section-toc";
import { decisionOptions } from "@/routes/_protected.knowledge/case-law/-queries/decisions";

export const Route = createFileRoute(
  "/_protected/knowledge/case-law/$decisionId",
)({
  loader: ({ context: { queryClient }, params: { decisionId } }) =>
    queryClient.ensureQueryData(decisionOptions(decisionId)),
  component: DecisionViewer,
});

function DecisionViewer() {
  const t = useTranslations();
  const { decisionId } = Route.useParams();
  const { data: decision } = useSuspenseQuery(decisionOptions(decisionId));

  if (!decision) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <p className="text-sm text-muted-foreground">
          {t("caseLaw.decisionNotFound")}
        </p>
      </div>
    );
  }

  // SAFETY: sections is JSONB written by our segmenter
  // (DecisionSection[]). Drizzle types JSONB as unknown.
  const sections = (decision.sections ?? []) as Array<{
    index: number;
    type: string;
    title: string | null;
    text: string;
  }>;

  return (
    <div className="flex flex-1 overflow-hidden">
      {/* Left: Section TOC */}
      {sections.length > 0 && (
        <aside className="hidden w-56 shrink-0 overflow-y-auto border-e p-3 lg:block">
          <SectionToc sections={sections} />
        </aside>
      )}

      {/* Center: Decision text */}
      <main className="flex-1 overflow-y-auto p-6">
        <DecisionText decision={decision} sections={sections} />
      </main>

      {/* Right: Metadata sidebar */}
      {decision.source && (
        <aside className="hidden w-72 shrink-0 overflow-y-auto border-s p-4 xl:block">
          <MetadataPanel
            decision={{
              ...decision,
              source: decision.source,
            }}
          />
        </aside>
      )}
    </div>
  );
}
