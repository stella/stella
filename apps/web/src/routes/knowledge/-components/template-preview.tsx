import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "use-intl";

import { TemplatePreviewView } from "@/features/knowledge/views/templates/template-preview-view";
import { useAuthenticatedUser } from "@/lib/authenticated-user-context";
import { templatePreviewOptions } from "@/lib/knowledge/queries";

/** The organization's template, previewed from its saved document. */
export const TemplatePreview = ({ templateId }: { templateId: string }) => {
  const t = useTranslations();
  const activeOrganizationId = useAuthenticatedUser().activeOrganizationId;

  const { data, isLoading, isError } = useQuery(
    templatePreviewOptions(activeOrganizationId, templateId),
  );

  if (isLoading) {
    return (
      <div className="flex items-center justify-center p-8">
        <p className="text-muted-foreground text-sm">{t("common.loading")}</p>
      </div>
    );
  }

  if (isError || !data || data instanceof Response || !("paragraphs" in data)) {
    return (
      <div className="flex items-center justify-center p-8">
        <p className="text-muted-foreground text-sm">
          {t("templates.previewFailed")}
        </p>
      </div>
    );
  }

  return (
    <TemplatePreviewView
      paragraphs={data.paragraphs}
      structureErrors={data.structureErrors}
    />
  );
};
