import { useState } from "react";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getRouteApi, useNavigate } from "@tanstack/react-router";
import { ArrowLeftIcon, LayoutTemplateIcon, SearchIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/components/button";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "@stll/ui/components/dialog";
import { Input } from "@stll/ui/components/input";

import { TemplateForm } from "@/routes/_protected.knowledge/-components/template-form";
import { useTemplateFillSchema } from "@/routes/_protected.knowledge/-components/use-template-fill-schema";
import { templatesOptions } from "@/routes/_protected.knowledge/-queries";
import { entitiesKeys } from "@/routes/_protected.workspaces/$workspaceId/-queries/entities";

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
                <ArrowLeftIcon />
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
  const { data, isLoading, isError } = useQuery(
    templatesOptions(activeOrganizationId),
  );

  const templates = data && "templates" in data ? data.templates : [];
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
      <div className="relative">
        <SearchIcon
          aria-hidden="true"
          className="text-muted-foreground pointer-events-none absolute start-2.5 top-1/2 size-3.5 -translate-y-1/2"
        />
        <Input
          autoFocus
          className="ps-8"
          onChange={(e) => setSearch(e.target.value)}
          placeholder={t("templates.searchTemplates")}
          type="search"
          value={search}
        />
      </div>
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
        onCreated: (entityId) => {
          queryClient
            .invalidateQueries({ queryKey: entitiesKeys.all(workspaceId) })
            .catch(() => {
              /* fire-and-forget */
            });
          onCreated();
          // Open the just-created document in the editable Folio editor (the
          // entities route resolves the file field and redirects into the
          // document view) so the user can hand-edit it right away.
          navigate({
            to: "/workspaces/$workspaceId/entities/$entityId",
            params: { workspaceId, entityId },
          }).catch(() => {
            /* navigation is best-effort; the document is already saved */
          });
        },
      }}
      structureErrors={fill.schema.structureErrors}
      templateId={template.id}
    />
  );
};
