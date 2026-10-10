import { useCallback, useState } from "react";

import { getRouteApi, Link } from "@tanstack/react-router";
import { useTranslations } from "use-intl";

import { LeaveConfirmDialog } from "@/features/knowledge/leave-confirm-dialog";
import {
  memberKnowledgeActions,
  memberKnowledgeSource,
} from "@/features/knowledge/member/member-knowledge";
import { KnowledgeStatusMessage } from "@/features/knowledge/views/knowledge-status-message";
import { StyleSetPickerDialog } from "@/features/style-sets/style-set-picker-dialog";
import type { StyleSelection } from "@/features/style-sets/style-set-picker-dialog";
import { useExternalSyncEffect } from "@/hooks/use-effect";
import { useFormatter } from "@/i18n/formatting-context";
import { detached } from "@/lib/detached";
import { toAPIError, APIError } from "@/lib/errors/api";
import { userErrorMessage } from "@/lib/errors/user-safe";
import { notifyUserError } from "@/lib/errors/user-toast";
import { isPublicKnowledgeEnabled } from "@/lib/knowledge/public-knowledge-launch";
import { TemplateList } from "@/routes/knowledge/-components/template-list";
import { TemplateStudioPage } from "@/routes/knowledge/-components/template-studio";
import { useTemplateStudioStore } from "@/routes/knowledge/-components/template-studio-store";
import { useTemplateNavStore } from "@/stores/knowledge/template-nav-store";

const DOCX_EXTENSION_RE = /\.docx$/iu;
const NOT_FOUND_STATUS = 404;

const templatesRouteApi = getRouteApi("/knowledge/templates");

/** The organization's template library and its Studio: the member side of
 *  the templates section. */
export function MemberTemplatesPage({
  organizationId: activeOrganizationId,
}: {
  /** The organization the section's gate selected; every read is keyed by it. */
  organizationId: string;
}) {
  const t = useTranslations();
  // The open template lives in the URL, so a reload lands back in its Studio.
  const openTemplateId = templatesRouteApi.useSearch({
    select: (s) => s.template,
  });
  const navigate = templatesRouteApi.useNavigate();
  const [confirmLeave, setConfirmLeave] = useState(false);
  const [stylePickerOpen, setStylePickerOpen] = useState(false);
  const [selectedCategoryId, setSelectedCategoryId] = useState<string | null>(
    null,
  );

  const templatesSource = memberKnowledgeSource.useTemplates(
    activeOrganizationId,
    selectedCategoryId,
  );
  const templateActions =
    memberKnowledgeActions.useTemplateActions(activeOrganizationId);
  const { invalidateTemplates, invalidateCategories } = templateActions;

  const handleCategorySelect = (id: string | null) => {
    setSelectedCategoryId(id);
  };

  // Studio state belongs to this route entry. Replacing it avoids leaving a
  // duplicate list entry behind when the Studio closes.
  const openStudio = useCallback(
    async (templateId: string) => {
      await navigate({ replace: true, search: { template: templateId } });
    },
    [navigate],
  );

  const closeStudio = useCallback(() => {
    detached(
      navigate({ replace: true, search: {} }),
      "knowledge-templates.close-studio",
    );
  }, [navigate]);

  // Uploading a template drops you straight into the Studio: create it (the
  // server discovers fields from the DOCX), then open the editor. Field/clause
  // config now happens in the Studio, so there's no separate configure step.
  const [uploading, setUploading] = useState(false);
  const openUploadedTemplate = useCallback(
    async (file: File) => {
      setUploading(true);
      const response = await templateActions.upload(
        file,
        file.name.replace(DOCX_EXTENSION_RE, ""),
      );
      if (response.error) {
        setUploading(false);
        notifyUserError(toAPIError(response.error), t("templates.saveFailed"), {
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
    [t, templateActions, invalidateTemplates, openStudio],
  );

  const openBlankTemplate = useCallback(
    async (name: string, style: StyleSelection) => {
      const response =
        style.type === "stella"
          ? await templateActions.createBlank(name)
          : await templateActions.createFromStyleSet(name, style.styleSetId);
      if (response.error) {
        notifyUserError(toAPIError(response.error), t("templates.saveFailed"), {
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
    [t, templateActions, invalidateTemplates, openStudio],
  );

  if (openTemplateId !== undefined) {
    const exitDetail = () => {
      closeStudio();
      invalidateTemplates();
    };
    return (
      <>
        <TemplateDetail
          organizationId={activeOrganizationId}
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

  // Loading and failed loads belong to the list view; an upload in flight
  // holds the page only once the list itself is ready.
  if (uploading && templatesSource.status === "ready") {
    return (
      <KnowledgeStatusMessage>{t("common.loading")}</KnowledgeStatusMessage>
    );
  }

  return (
    <>
      <TemplateList
        catalogueTab={
          isPublicKnowledgeEnabled() ? <CatalogueTabLink /> : undefined
        }
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
          detached(
            templatesSource.fetchNextPage(),
            "knowledge-templates.fetch-next-page",
          );
        }}
        onSelect={(template) => {
          detached(openStudio(template.id), "knowledge-templates.open-studio");
        }}
        source={templatesSource}
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
  organizationId: activeOrganizationId,
}: {
  organizationId: string;
  templateId: string;
  onBack: () => void;
  /** The id cannot be opened by this org, so the URL must stop naming it. */
  onMissing: () => void;
}) => {
  const t = useTranslations();
  const format = useFormatter();
  const setNavOpen = useTemplateNavStore((s) => s.setOpen);
  const clearNav = useTemplateNavStore((s) => s.clear);

  const {
    data: detailData,
    isLoading,
    isError,
    error,
  } = memberKnowledgeSource.useTemplateDetail(activeOrganizationId, templateId);

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
      {(state === "loading" || missing) && (
        <div className="flex flex-1 items-center justify-center p-8">
          <p className="text-muted-foreground text-sm">{t("common.loading")}</p>
        </div>
      )}

      {state === "error" && !missing && (
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

/** The way from the library to the published catalogue. */
const CatalogueTabLink = () => {
  const t = useTranslations();
  return (
    <Link
      className="text-muted-foreground hover:text-foreground text-sm"
      to="/knowledge/templates/catalogue"
    >
      {t("common.catalogue")}
    </Link>
  );
};
