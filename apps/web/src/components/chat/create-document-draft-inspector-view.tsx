import { lazy, Suspense } from "react";

import { useTranslations } from "use-intl";

import type { CreateDocumentDraftPayload } from "@/components/chat/create-document-draft.logic";
import { DocumentIcon } from "@/components/document-icon";
import { InspectorTabHeader } from "@/components/inspector/inspector-tab-header";
import type {
  InspectorRailIconProps,
  InspectorViewRenderProps,
} from "@/components/inspector/view-registry";
import { DOCX_MIME } from "@/lib/consts";

const LazyCreateDocumentDraftEditor = lazy(async () => {
  const module =
    await import("@/components/chat/create-document-draft-inspector-editor");
  return { default: module.CreateDocumentDraftInspectorEditor };
});

export const CreateDocumentDraftInspector = ({
  tab,
  onClose,
}: InspectorViewRenderProps<CreateDocumentDraftPayload>) => {
  const t = useTranslations();
  return (
    <div className="bg-background flex min-h-0 flex-1 flex-col overflow-hidden">
      <InspectorTabHeader label={tab.label} onClose={onClose} />
      <Suspense
        fallback={
          <div className="text-muted-foreground flex min-h-0 flex-1 items-center justify-center p-6 text-sm">
            {t("common.loading")}
          </div>
        }
      >
        <LazyCreateDocumentDraftEditor key={tab.id} payload={tab.payload} />
      </Suspense>
    </div>
  );
};

export const CreateDocumentDraftRailIcon = ({
  active,
  tab,
}: InspectorRailIconProps<CreateDocumentDraftPayload>) => (
  <DocumentIcon
    className={active ? "size-3.5" : "size-3.5 opacity-70"}
    fileName={tab.label}
    mimeType={DOCX_MIME}
  />
);
