import { useCallback, useState } from "react";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, getRouteApi } from "@tanstack/react-router";
import { useFormatter, useTranslations } from "use-intl";

import { Skeleton } from "@stll/ui/components/skeleton";
import { stellaToast } from "@stll/ui/components/toast";

import { useExternalSyncEffect } from "@/hooks/use-effect";
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

const TEMPLATE_SIDEBAR_KEYS = ["a", "b", "c", "d", "e"];
const TEMPLATE_ROW_KEYS = ["a", "b", "c", "d", "e", "f"];

// Mirrors the TemplateList layout (w-48 category sidebar + bordered list
// pane with count/new-template toolbar and divided rows) so the page
// keeps its shape while templates load; only the values fade in.
function TemplatesPageSkeleton() {
  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex w-48 shrink-0 flex-col overflow-y-auto">
        <nav className="flex-1 space-y-1 p-2">
          <Skeleton className="h-7 w-full rounded-md" />
          <div className="my-1 border-t" />
          {TEMPLATE_SIDEBAR_KEYS.map((key) => (
            <Skeleton className="h-7 w-2/3 rounded-md" key={key} />
          ))}
        </nav>
      </div>

      <div className="flex min-h-0 flex-1 flex-col border-s">
        <div className="flex items-center justify-between border-b px-4 py-2">
          <Skeleton className="h-4 w-8" />
          <Skeleton className="h-8 w-32 rounded-md" />
        </div>

        <ul className="flex-1 divide-y overflow-y-auto">
          {TEMPLATE_ROW_KEYS.map((key) => (
            <li className="flex items-center gap-4 px-4 py-3" key={key}>
              <Skeleton className="size-9 shrink-0 rounded-lg" />
              <div className="min-w-0 flex-1 space-y-1.5">
                <Skeleton className="h-4 w-48" />
                <Skeleton className="h-3 w-32" />
              </div>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

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

  const handleCategorySelect = (id: string | null) => {
    setSelectedCategoryId(id);
  };

  const invalidateTemplates = () => {
    queryClient
      .invalidateQueries({
        queryKey: knowledgeKeys.templates.all(activeOrganizationId),
      })
      .catch(() => {
        /* fire-and-forget */
      });
  };

  const invalidateCategories = () => {
    queryClient
      .invalidateQueries({
        queryKey: knowledgeKeys.templateCategories.all(activeOrganizationId),
      })
      .catch(() => {
        /* fire-and-forget */
      });
  };

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

  // Creating a blank template is the primary path: the server stamps out a
  // Folio-native empty DOCX, then we drop straight into the Studio where the
  // user authors the body and adds {{fields}} (no upload, no AI).
  const openBlankTemplate = useCallback(async () => {
    setCreating(true);
    const response = await api.templates.blank.put({
      name: t("templates.untitledTemplate"),
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
  }, [t, invalidateTemplates]);

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
              // Await the save before exiting: exitDetail() unmounts the Studio
              // page, whose cleanup resets the shared store. Leaving only after
              // a successful save (and the reset itself is gated on !isSaving)
              // keeps the unmount from clobbering an in-flight save. On failure
              // the save toast surfaces and we stay in the detail view.
              void (async () => {
                const saved = await useTemplateStudioStore
                  .getState()
                  .actions?.save();
                if (saved) {
                  exitDetail();
                }
              })();
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
    return <TemplatesPageSkeleton />;
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
      onCreateBlank={() => {
        void openBlankTemplate();
      }}
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
  useExternalSyncEffect(() => {
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
