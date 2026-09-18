import { useCallback, useState } from "react";

import {
  useInfiniteQuery,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { createFileRoute, getRouteApi } from "@tanstack/react-router";
import { useTranslations } from "use-intl";

import { Skeleton } from "@stll/ui/skeleton";
import { stellaToast } from "@stll/ui/toast";

import { StyleSetPickerDialog } from "@/features/style-sets/style-set-picker-dialog";
import type { StyleSelection } from "@/features/style-sets/style-set-picker-dialog";
import { useExternalSyncEffect } from "@/hooks/use-effect";
import { useFormatter } from "@/i18n/formatting-context";
import { api } from "@/lib/api";
import { detached } from "@/lib/detached";
import { APIError } from "@/lib/errors/api";
import { userErrorMessage } from "@/lib/errors/user-safe";
import {
  knowledgeKeys,
  templateCategoriesOptions,
  templateDetailOptions,
  templatesOptions,
} from "@/lib/knowledge/queries";
import { toSafeId } from "@/lib/safe-id";
import { LeaveConfirmDialog } from "@/routes/_protected.knowledge/-components/leave-confirm-dialog";
import { TemplateList } from "@/routes/_protected.knowledge/-components/template-list";
import { TemplateStudioPage } from "@/routes/_protected.knowledge/-components/template-studio";
import { useTemplateStudioStore } from "@/routes/_protected.knowledge/-components/template-studio-store";
import { templatesSearchSchema } from "@/routes/_protected.knowledge/-templates-search";
import { useTemplateNavStore } from "@/stores/knowledge/template-nav-store";

const DOCX_EXTENSION_RE = /\.docx$/iu;
const NOT_FOUND_STATUS = 404;

export const Route = createFileRoute("/_protected/knowledge/templates")({
  validateSearch: templatesSearchSchema,
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
  // The open template lives in the URL, so a reload lands back in its Studio.
  const openTemplateId = Route.useSearch({ select: (s) => s.template });
  const navigate = Route.useNavigate();
  const [confirmLeave, setConfirmLeave] = useState(false);
  const [stylePickerOpen, setStylePickerOpen] = useState(false);
  const [selectedCategoryId, setSelectedCategoryId] = useState<string | null>(
    null,
  );

  const {
    data: templatesData,
    isLoading: templatesLoading,
    isError: templatesError,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = useInfiniteQuery(
    templatesOptions(activeOrganizationId, selectedCategoryId),
  );
  const { data: categoriesData } = useQuery(
    templateCategoriesOptions(activeOrganizationId),
  );

  const templates = templatesData
    ? templatesData.pages.flatMap((page) => page.items)
    : [];
  const categories =
    categoriesData && "categories" in categoriesData
      ? categoriesData.categories
      : [];

  const handleCategorySelect = (id: string | null) => {
    setSelectedCategoryId(id);
  };

  const invalidateTemplates = useCallback(() => {
    detached(
      queryClient.invalidateQueries({
        queryKey: knowledgeKeys.templates.all(activeOrganizationId),
      }),
      "knowledge-templates.invalidate-templates",
    );
  }, [queryClient, activeOrganizationId]);

  // Opening pushes, so Back returns to the list. Leaving replaces the entry it
  // just pushed, so Back from the list does not walk into the Studio again.
  const openStudio = useCallback(
    async (templateId: string) => {
      await navigate({ search: { template: templateId } });
    },
    [navigate],
  );

  const closeStudio = useCallback(() => {
    detached(
      navigate({ replace: true, search: {} }),
      "knowledge-templates.close-studio",
    );
  }, [navigate]);

  const invalidateCategories = () => {
    detached(
      queryClient.invalidateQueries({
        queryKey: knowledgeKeys.templateCategories.all(activeOrganizationId),
      }),
      "knowledge-templates.invalidate-categories",
    );
  };

  // Uploading a template drops you straight into the Studio: create it (the
  // server discovers fields from the DOCX), then open the editor. Field/clause
  // config now happens in the Studio, so there's no separate configure step.
  const [uploading, setUploading] = useState(false);
  const openUploadedTemplate = useCallback(
    async (file: File) => {
      setUploading(true);
      const response = await api.templates.put({
        file,
        name: file.name.replace(DOCX_EXTENSION_RE, ""),
      });
      if (response.error) {
        setUploading(false);
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
      invalidateTemplates();
      // Hold the upload placeholder until the Studio's URL has landed, so the
      // list cannot flash between the two.
      await openStudio(response.data.id);
      setUploading(false);
    },
    [t, invalidateTemplates, openStudio],
  );

  const openBlankTemplate = useCallback(
    async (name: string, style: StyleSelection) => {
      const response =
        style.type === "stella"
          ? await api.templates.blank.put({ name })
          : await api.templates["style-set"].put({
              name,
              styleSetId: toSafeId<"styleSet">(style.styleSetId),
            });
      if (response.error) {
        stellaToast.add({
          type: "error",
          title: t("templates.saveFailed"),
          description: userErrorMessage(
            response.error,
            t("common.unexpectedError"),
          ),
        });
        return false;
      }
      invalidateTemplates();
      await openStudio(response.data.id);
      return true;
    },
    [t, invalidateTemplates, openStudio],
  );

  if (openTemplateId !== undefined) {
    const exitDetail = () => {
      closeStudio();
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
          onMissing={closeStudio}
          templateId={openTemplateId}
        />
        <LeaveConfirmDialog
          cancelLabel={t("common.goBackToEditing")}
          description={t("common.unsavedLeaveConfirm")}
          onOpenChange={setConfirmLeave}
          open={confirmLeave}
          primary={{
            label: t("common.saveAndLeave"),
            onClick: () => {
              // Await the save before exiting: exitDetail() unmounts the Studio
              // page, whose cleanup resets the shared store. Leaving only after
              // a successful save (and the reset itself is gated on !isSaving)
              // keeps the unmount from clobbering an in-flight save. On failure
              // the save toast surfaces and we stay in the detail view.
              detached(
                (async () => {
                  const saved = await useTemplateStudioStore
                    .getState()
                    .actions?.save();
                  if (saved) {
                    exitDetail();
                  }
                })(),
                "knowledge-templates.save",
              );
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

  if (uploading) {
    return (
      <div className="flex flex-1 items-center justify-center p-8">
        <p className="text-muted-foreground text-sm">{t("common.loading")}</p>
      </div>
    );
  }

  return (
    <>
      <TemplateList
        categories={categories}
        hasNextPage={hasNextPage}
        isFetchingNextPage={isFetchingNextPage}
        onCategoriesChanged={invalidateCategories}
        onCategorySelect={handleCategorySelect}
        onCreateBlank={() => setStylePickerOpen(true)}
        onDeleted={invalidateTemplates}
        onDiscovered={(file) => {
          detached(
            openUploadedTemplate(file),
            "knowledge-templates.open-uploaded-template",
          );
        }}
        onLoadMore={() => {
          detached(fetchNextPage(), "knowledge-templates.fetch-next-page");
        }}
        onSelect={(template) => {
          detached(openStudio(template.id), "knowledge-templates.open-studio");
        }}
        selectedCategoryId={selectedCategoryId}
        templates={templates}
      />
      <StyleSetPickerDialog
        initialName={t("templates.untitledTemplate")}
        onCreate={openBlankTemplate}
        onOpenChange={setStylePickerOpen}
        open={stylePickerOpen}
        title={t("templates.newTemplate")}
      />
    </>
  );
}

/** Template detail view: loads the template + opens the full Studio. Rename
 *  lives in the Studio's inspector tab header; the name shows in the breadcrumb
 *  (published via the nav store). */
const TemplateDetail = ({
  templateId,
  onBack,
  onMissing,
}: {
  templateId: string;
  onBack: () => void;
  /** The id cannot be opened by this org, so the URL must stop naming it. */
  onMissing: () => void;
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
    error,
  } = useQuery(templateDetailOptions(activeOrganizationId, templateId));

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

  // A `?template=` naming a template this org cannot open (deleted, or never
  // theirs) is not a state to sit on: drop the param and show the list. Silent
  // on purpose — a stale link is not worth a toast.
  const missing = APIError.is(error) && error.status === NOT_FOUND_STATUS;
  useExternalSyncEffect(() => {
    if (missing) {
      onMissing();
    }
  }, [missing, onMissing]);

  // Publish the open template to the breadcrumb (Knowledge › Templates › Name)
  // and wire its "Templates" crumb back to the list; clear on leave. The name
  // arrives with the detail, so the crumb grows its tail once it loads.
  const openName = detail?.name ?? null;
  useExternalSyncEffect(() => {
    if (openName === null) {
      return undefined;
    }
    setNavOpen({ id: templateId, name: openName, exit: onBack });
    return () => clearNav();
  }, [templateId, openName, onBack, setNavOpen, clearNav]);

  const fieldCount = detail
    ? (detail.manifest?.fields.length ?? detail.fieldCount)
    : 0;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {state === "loading" && (
        <div className="flex flex-1 items-center justify-center p-8">
          <p className="text-muted-foreground text-sm">{t("common.loading")}</p>
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
          metaLabel={`${t("templates.fieldCount", { count: fieldCount })} \u00b7 ${format.dateTime(new Date(detail.createdAt), { dateStyle: "medium" })}`}
          name={detail.name}
          presignedUrl={detail.presignedUrl}
          templateId={templateId}
        />
      )}
    </div>
  );
};
