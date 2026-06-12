import { useCallback, useEffect, useState } from "react";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, getRouteApi } from "@tanstack/react-router";
import { useFormatter, useTranslations } from "use-intl";

import { stellaToast } from "@stll/ui/components/toast";

import { api } from "@/lib/api";
import { userErrorMessage } from "@/lib/errors";
import { LeaveConfirmDialog } from "@/routes/_protected.knowledge/-components/leave-confirm-dialog";
import { TemplateList } from "@/routes/_protected.knowledge/-components/template-list";
import { useTemplateNavStore } from "@/routes/_protected.knowledge/-components/template-nav-store";
import { TemplateStudioPage } from "@/routes/_protected.knowledge/-components/template-studio";
import { useTemplateStudioStore } from "@/routes/_protected.knowledge/-components/template-studio-store";
import {
  knowledgeKeys,
  templateCategoriesOptions,
  templateDetailOptions,
  templatesOptions,
} from "@/routes/_protected.knowledge/-queries";

type TemplateItem = {
  id: string;
  name: string;
  fileName: string;
  fieldCount: number;
  sizeBytes: number;
  categoryId: string | null;
  createdAt: Date;
};

const DOCX_EXTENSION_RE = /\.docx$/iu;

type View = { kind: "list" } | { kind: "detail"; template: TemplateItem };

export const Route = createFileRoute("/_protected/knowledge/templates")({
  component: RouteComponent,
});

const protectedRouteApi = getRouteApi("/_protected");

function RouteComponent() {
  const t = useTranslations();
  const queryClient = useQueryClient();
  const activeOrganizationId = protectedRouteApi.useRouteContext({
    select: (ctx) => ctx.user.activeOrganizationId,
  });
  const [view, setView] = useState<View>({ kind: "list" });
  const [confirmLeave, setConfirmLeave] = useState(false);
  const [selectedCategoryId, setSelectedCategoryId] = useState<string | null>(
    null,
  );

  const {
    data: templatesData,
    isLoading: templatesLoading,
    isError: templatesError,
  } = useQuery(templatesOptions(activeOrganizationId, selectedCategoryId));
  const { data: categoriesData } = useQuery(
    templateCategoriesOptions(activeOrganizationId),
  );

  const templates =
    templatesData && "templates" in templatesData
      ? templatesData.templates
      : [];
  const categories =
    categoriesData && "categories" in categoriesData
      ? categoriesData.categories
      : [];

  const handleCategorySelect = useCallback((id: string | null) => {
    setSelectedCategoryId(id);
  }, []);

  const invalidateTemplates = useCallback(() => {
    queryClient
      .invalidateQueries({
        queryKey: knowledgeKeys.templates.all(activeOrganizationId),
      })
      .catch(() => {
        /* fire-and-forget */
      });
  }, [queryClient, activeOrganizationId]);

  const invalidateCategories = useCallback(() => {
    queryClient
      .invalidateQueries({
        queryKey: knowledgeKeys.templateCategories.all(activeOrganizationId),
      })
      .catch(() => {
        /* fire-and-forget */
      });
  }, [queryClient, activeOrganizationId]);

  // Uploading a template drops you straight into the Studio: create it (the
  // server discovers fields from the DOCX), then open the editor. Field/clause
  // config now happens in the Studio, so there's no separate configure step.
  const [creating, setCreating] = useState(false);
  const openUploadedTemplate = useCallback(
    async (file: File) => {
      setCreating(true);
      const response = await api.templates.put({
        file,
        name: file.name.replace(DOCX_EXTENSION_RE, ""),
      });
      setCreating(false);
      if (response.error) {
        stellaToast.add({
          type: "error",
          title: t("templates.saveFailed"),
          description: userErrorMessage(
            response.error,
            t("common.unexpectedError"),
          ),
        });
        return;
      }
      const created = response.data;
      invalidateTemplates();
      setView({
        kind: "detail",
        template: {
          id: created.id,
          name: created.name,
          fileName: created.fileName,
          fieldCount: created.fieldCount,
          sizeBytes: created.sizeBytes,
          categoryId: null,
          createdAt: new Date(created.createdAt),
        },
      });
    },
    [t, invalidateTemplates],
  );

  if (view.kind === "detail") {
    const exitDetail = () => {
      setView({ kind: "list" });
      invalidateTemplates();
    };
    return (
      <>
        <TemplateDetail
          onBack={() => {
            // Leaving the Studio discards unsaved document/manifest edits.
            if (useTemplateStudioStore.getState().isDirty) {
              setConfirmLeave(true);
              return;
            }
            exitDetail();
          }}
          template={view.template}
        />
        <LeaveConfirmDialog
          cancelLabel={t("templates.goBackToEditing")}
          description={t("templates.unsavedLeaveConfirm")}
          onOpenChange={setConfirmLeave}
          open={confirmLeave}
          primary={{
            label: t("templates.saveAndLeave"),
            onClick: () => {
              useTemplateStudioStore.getState().actions?.save();
              exitDetail();
            },
          }}
          secondary={{
            label: t("folio.discardChanges"),
            variant: "destructive",
            onClick: exitDetail,
          }}
        />
      </>
    );
  }

  if (templatesLoading) {
    return (
      <div className="flex flex-1 items-center justify-center p-8">
        <p className="text-muted-foreground text-sm">
          {t("templates.discovering")}
        </p>
      </div>
    );
  }

  if (templatesError) {
    return (
      <div className="flex flex-1 items-center justify-center p-8">
        <p className="text-muted-foreground text-sm">
          {t("templates.loadFailed")}
        </p>
      </div>
    );
  }

  if (creating) {
    return (
      <div className="flex flex-1 items-center justify-center p-8">
        <p className="text-muted-foreground text-sm">
          {t("templates.discovering")}
        </p>
      </div>
    );
  }

  return (
    <TemplateList
      categories={categories}
      onCategoriesChanged={invalidateCategories}
      onCategorySelect={handleCategorySelect}
      onDeleted={invalidateTemplates}
      onDiscovered={(file) => {
        void openUploadedTemplate(file);
      }}
      onSelect={(template) => setView({ kind: "detail", template })}
      selectedCategoryId={selectedCategoryId}
      templates={templates}
    />
  );
}

/** Template detail view: loads the template + opens the full Studio. Rename
 *  lives in the Studio's inspector tab header; the name shows in the breadcrumb
 *  (published via the nav store). */
const TemplateDetail = ({
  template,
  onBack,
}: {
  template: TemplateItem;
  onBack: () => void;
}) => {
  const t = useTranslations();
  const format = useFormatter();
  const setNavOpen = useTemplateNavStore((s) => s.setOpen);
  const clearNav = useTemplateNavStore((s) => s.clear);

  const activeOrganizationId = protectedRouteApi.useRouteContext({
    select: (ctx) => ctx.user.activeOrganizationId,
  });

  const {
    data: detailData,
    isLoading,
    isError,
  } = useQuery(templateDetailOptions(activeOrganizationId, template.id));

  const detail =
    detailData &&
    !(detailData instanceof Response) &&
    "presignedUrl" in detailData
      ? detailData
      : null;

  const state: "loading" | "error" | "ready" = (() => {
    if (isLoading) {
      return "loading";
    }
    if (isError || !detail) {
      return "error";
    }
    return "ready";
  })();

  // Publish the open template to the breadcrumb (Knowledge › Templates › Name)
  // and wire its "Templates" crumb back to the list; clear on leave.
  useEffect(() => {
    setNavOpen({ templateId: template.id, name: template.name, exit: onBack });
    return () => clearNav();
  }, [template.id, template.name, onBack, setNavOpen, clearNav]);

  const fieldCount = detail?.manifest?.fields.length ?? template.fieldCount;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {state === "loading" && (
        <div className="flex flex-1 items-center justify-center p-8">
          <p className="text-muted-foreground text-sm">
            {t("templates.discovering")}
          </p>
        </div>
      )}

      {state === "error" && (
        <div className="flex flex-1 items-center justify-center p-8">
          <p className="text-muted-foreground text-sm">
            {t("templates.loadFailed")}
          </p>
        </div>
      )}

      {state === "ready" && detail && (
        <TemplateStudioPage
          fileName={detail.fileName}
          manifest={detail.manifest}
          metaLabel={`${t("templates.fieldCount", { count: fieldCount })} \u00b7 ${format.dateTime(new Date(template.createdAt), { dateStyle: "medium" })}`}
          name={template.name}
          presignedUrl={detail.presignedUrl}
          templateId={template.id}
        />
      )}
    </div>
  );
};
