import { useState } from "react";

import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { getRouteApi, useNavigate } from "@tanstack/react-router";
import { panic } from "better-result";
import { ArrowLeftIcon, LayoutTemplateIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "@stll/ui/dialog";
import { DirectionalIcon } from "@stll/ui/directional-icon";
import { Input } from "@stll/ui/input";

import { TemplateForm } from "@/components/templates/template-form";
import { useTemplateFillSchema } from "@/components/templates/use-template-fill-schema";
import { useExternalSyncEffect } from "@/hooks/use-effect";
import { detached } from "@/lib/detached";
import { templatesOptions } from "@/lib/knowledge/queries";
import { entitiesKeys } from "@/lib/workspaces/queries/entities";

/**
 * "New document from template" inside a matter: pick a saved template
 * (filterable list), fill it — with optional AI prefill from this matter's
 * documents — and the result lands as a DOCX document entity in the matter.
 */

type NewDocumentFromTemplateDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceId: string;
  parentId?: string | null | undefined;
};

const protectedRouteApi = getRouteApi("/_protected");

export const NewDocumentFromTemplateDialog = ({
  open,
  onOpenChange,
  workspaceId,
  parentId,
}: NewDocumentFromTemplateDialogProps) => (
  <Dialog onOpenChange={onOpenChange} open={open}>
    {/* Mount only while open so each open starts at the template picker. */}
    {open ? (
      <NewDocumentFromTemplateDialogBody
        onOpenChange={onOpenChange}
        parentId={parentId}
        workspaceId={workspaceId}
      />
    ) : null}
  </Dialog>
);

type PickedTemplate = { id: string; name: string };

const NewDocumentFromTemplateDialogBody = ({
  onOpenChange,
  workspaceId,
  parentId,
}: Omit<NewDocumentFromTemplateDialogProps, "open">) => {
  const t = useTranslations();
  const [picked, setPicked] = useState<PickedTemplate | null>(null);

  return (
    <DialogPopup className="sm:max-w-3xl">
      <DialogHeader>
        <DialogTitle>
          {picked ? picked.name : t("templates.newFromTemplate")}
        </DialogTitle>
        <DialogDescription>
          {picked
            ? t("templates.newFromTemplateFillHint")
            : t("templates.pickTemplate")}
        </DialogDescription>
      </DialogHeader>
      <DialogPanel className="flex max-h-[70vh] min-h-48 flex-col overflow-hidden p-0">
        {picked === null ? (
          <TemplatePickList onPick={setPicked} />
        ) : (
          <>
            <div className="border-b px-4 py-2">
              <Button
                onClick={() => setPicked(null)}
                size="sm"
                type="button"
                variant="ghost"
              >
                <DirectionalIcon icon={ArrowLeftIcon} />
                {t("common.goBack")}
              </Button>
            </div>
            <FillStep
              onCreated={() => onOpenChange(false)}
              parentId={parentId ?? null}
              template={picked}
              workspaceId={workspaceId}
            />
          </>
        )}
      </DialogPanel>
    </DialogPopup>
  );
};

const TemplatePickList = ({
  onPick,
}: {
  onPick: (template: PickedTemplate) => void;
}) => {
  const t = useTranslations();
  const [search, setSearch] = useState("");
  const activeOrganizationId = protectedRouteApi.useRouteContext({
    select: (ctx) => ctx.user.activeOrganizationId,
  });
  const {
    data,
    isLoading,
    isError,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = useInfiniteQuery(templatesOptions(activeOrganizationId));

  // The picker filters client-side, so it needs the full template set: keep
  // fetching pages until the list is complete rather than a manual load-more.
  useExternalSyncEffect(() => {
    if (!hasNextPage || isFetchingNextPage) {
      return;
    }
    detached(
      fetchNextPage(),
      "new-document-from-template-dialog.fetch-next-page",
    );
  }, [fetchNextPage, hasNextPage, isFetchingNextPage]);

  const templates = data ? data.pages.flatMap((page) => page.items) : [];
  const query = search.trim().toLowerCase();
  const visibleTemplates =
    query === ""
      ? templates
      : templates.filter((template) =>
          template.name.toLowerCase().includes(query),
        );

  if (isLoading) {
    return (
      <p className="text-muted-foreground p-6 text-sm">{t("common.loading")}</p>
    );
  }
  if (isError) {
    return (
      <p className="text-muted-foreground p-6 text-sm">
        {t("templates.loadFailed")}
      </p>
    );
  }
  if (templates.length === 0) {
    return (
      <p className="text-muted-foreground p-6 text-sm">
        {t("templates.noTemplates")}
      </p>
    );
  }

  return (
    <div className="flex min-h-0 flex-col gap-2 p-4">
      <Input
        autoFocus
        onChange={(e) => setSearch(e.target.value)}
        placeholder={t("templates.searchTemplates")}
        type="search"
        value={search}
      />
      <ul className="min-h-0 flex-1 divide-y overflow-y-auto rounded-lg border">
        {visibleTemplates.length === 0 && (
          <li className="text-muted-foreground p-3 text-sm">
            {t("templates.noTemplates")}
          </li>
        )}
        {visibleTemplates.map((template) => (
          <li key={template.id}>
            <button
              className="hover:bg-muted/50 flex w-full items-center gap-3 px-3 py-2.5 text-start"
              onClick={() => onPick({ id: template.id, name: template.name })}
              type="button"
            >
              <div className="bg-muted flex size-8 shrink-0 items-center justify-center rounded-lg">
                <LayoutTemplateIcon className="text-muted-foreground size-4" />
              </div>
              <span className="min-w-0 flex-1 truncate text-sm font-medium">
                {template.name}
              </span>
              <span className="text-muted-foreground shrink-0 text-xs">
                {t("templates.fieldCount", { count: template.fieldCount })}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
};

const FillStep = ({
  template,
  workspaceId,
  parentId,
  onCreated,
}: {
  template: PickedTemplate;
  workspaceId: string;
  parentId: string | null;
  onCreated: () => void;
}) => {
  const t = useTranslations();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const fill = useTemplateFillSchema(template.id);

  if (fill.state === "loading") {
    return (
      <p className="text-muted-foreground p-6 text-sm">{t("common.loading")}</p>
    );
  }
  if (fill.state === "error") {
    return (
      <p className="text-muted-foreground p-6 text-sm">
        {t("templates.loadFailed")}
      </p>
    );
  }

  return (
    <TemplateForm
      conditions={fill.schema.conditions}
      fields={fill.schema.fields}
      fileName={fill.fileName}
      onBack={() => undefined}
      onDone={() => undefined}
      prefill={{ workspaceId }}
      saveTarget={{
        kind: "matter",
        workspaceId,
        parentId,
        onCreated: (created) => {
          const { entityId } = created;
          detached(
            queryClient.invalidateQueries({
              queryKey: entitiesKeys.all(workspaceId),
            }),
            "new-document-from-template-dialog.invalidate",
          );
          onCreated();
          switch (created.type) {
            case "document":
              // Open the just-created document in the editable Folio editor.
              detached(
                navigate({
                  to: "/workspaces/$workspaceId/$viewId/document",
                  params: { workspaceId, viewId: "all" },
                  search: { entity: entityId, field: created.fieldId },
                }),
                "new-document-from-template-dialog.navigate",
              );
              return;
            case "workspace":
              detached(
                navigate({
                  to: "/workspaces/$workspaceId/$viewId",
                  params: { workspaceId, viewId: "all" },
                }),
                "new-document-from-template-dialog.navigate",
              );
              return;
            default:
              created satisfies never;
              panic(`Unhandled created: ${String(created)}`);
          }
        },
      }}
      structureErrors={fill.schema.structureErrors}
      templateId={template.id}
    />
  );
};
