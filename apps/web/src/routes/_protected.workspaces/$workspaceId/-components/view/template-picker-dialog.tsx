import { useState } from "react";

import { useQuery } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import {
  CalendarIcon,
  FolderTreeIcon,
  GanttChartIcon,
  KanbanIcon,
  LayoutDashboardIcon,
  TableIcon,
  Trash2Icon,
} from "lucide-react";
import { useTranslations } from "use-intl";

import type { ViewLayoutType } from "@stll/api/types";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@stll/ui/components/alert-dialog";
import { Button } from "@stll/ui/components/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "@stll/ui/components/dialog";
import { ScrollArea } from "@stll/ui/components/scroll-area";
import { stellaToast } from "@stll/ui/components/toast";
import { cn } from "@stll/ui/lib/utils";

import { usePermissions } from "@/hooks/use-permissions";
import { ViewLayoutPreview } from "@/routes/_protected.workspaces/$workspaceId/-components/view/view-layout-preview";
import { useStartWorkflow } from "@/routes/_protected.workspaces/$workspaceId/-hooks/use-start-workflow";
import { useDeleteViewTemplate } from "@/routes/_protected.workspaces/$workspaceId/-mutations/view-templates";
import { useCreateView } from "@/routes/_protected.workspaces/$workspaceId/-mutations/views";
import type { WorkspaceViewTemplate } from "@/routes/_protected.workspaces/$workspaceId/-queries/view-templates";
import { viewTemplatesOptions } from "@/routes/_protected.workspaces/$workspaceId/-queries/view-templates";

const layoutIcons = {
  overview: LayoutDashboardIcon,
  table: TableIcon,
  filesystem: FolderTreeIcon,
  kanban: KanbanIcon,
  calendar: CalendarIcon,
  timeline: GanttChartIcon,
} as const satisfies Record<ViewLayoutType, React.ElementType>;

type TemplatePickerDialogProps = {
  workspaceId: string;
  disallowedLayoutTypes: ReadonlySet<ViewLayoutType>;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (viewId: string) => void;
};

export const TemplatePickerDialog = ({
  workspaceId,
  disallowedLayoutTypes,
  open,
  onOpenChange,
  onCreated,
}: TemplatePickerDialogProps) => {
  const t = useTranslations();
  const organizationId = useRouteContext({
    from: "/_protected",
    select: (ctx) => ctx.user.activeOrganizationId,
  });
  const canDeleteTemplate = usePermissions({ view: ["delete"] });
  const [previewLayout, setPreviewLayout] = useState<ViewLayoutType | null>(
    null,
  );
  const { data: templates, isPending } = useQuery({
    ...viewTemplatesOptions({
      key: { organizationId },
      context: { workspaceId },
    }),
    enabled: open,
  });
  const visibleTemplates = templates?.filter(
    (template) => !disallowedLayoutTypes.has(template.layoutType),
  );
  const hasTemplates = (visibleTemplates?.length ?? 0) > 0;

  const createView = useCreateView(workspaceId);
  const deleteTemplate = useDeleteViewTemplate();
  const startWorkflow = useStartWorkflow(workspaceId);

  const handleUse = (template: WorkspaceViewTemplate) => {
    const newId = crypto.randomUUID();
    const hasAITemplateProperty = template.templateProperties.some(
      (p) => p.createIfMissing && p.tool.type === "ai-model",
    );
    createView.mutate(
      {
        id: newId,
        name: template.name,
        layout: template.layout,
        templateProperties: template.templateProperties,
      },
      {
        onSuccess: () => {
          onCreated(newId);
          onOpenChange(false);
          if (hasAITemplateProperty) {
            void startWorkflow();
          }
        },
        onError: () => {
          stellaToast.add({
            title: t("errors.failedToCreateView"),
            type: "error",
          });
        },
      },
    );
  };

  const handleDelete = (templateId: string) => {
    deleteTemplate.mutate(
      { workspaceId, templateId },
      {
        onSuccess: () => {
          stellaToast.add({
            title: t("workspaces.views.templates.deleted"),
            type: "success",
          });
        },
        onError: () => {
          stellaToast.add({
            title: t("errors.failedToDeleteTemplate"),
            type: "error",
          });
        },
      },
    );
  };

  return (
    <Dialog
      onOpenChange={(nextOpen) => {
        if (!nextOpen) {
          setPreviewLayout(null);
        }
        onOpenChange(nextOpen);
      }}
      open={open}
    >
      <DialogPopup
        className={cn("sm:max-w-md", hasTemplates && "sm:max-w-2xl")}
      >
        <DialogHeader>
          <DialogTitle>{t("workspaces.views.templates.title")}</DialogTitle>
          <DialogDescription>
            {t("workspaces.views.templates.description")}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="flex items-stretch">
            <div className="min-w-0 flex-1">
              <TemplateList
                canDeleteTemplate={canDeleteTemplate}
                isMutating={createView.isPending || deleteTemplate.isPending}
                isPending={isPending}
                onDelete={handleDelete}
                onPreview={setPreviewLayout}
                onUse={handleUse}
                templates={visibleTemplates}
              />
            </div>
            {hasTemplates && (
              <div className="ms-3 hidden border-s ps-1 sm:block">
                <ViewLayoutPreview
                  kind={previewLayout}
                  workspaceId={workspaceId}
                />
              </div>
            )}
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button onClick={() => onOpenChange(false)} variant="ghost">
            {t("common.close")}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
};

type TemplateListProps = {
  templates: WorkspaceViewTemplate[] | undefined;
  isPending: boolean;
  isMutating: boolean;
  canDeleteTemplate: boolean;
  onUse: (template: WorkspaceViewTemplate) => void;
  onDelete: (templateId: string) => void;
  onPreview: (layoutType: ViewLayoutType) => void;
};

const TemplateList = ({
  templates,
  isPending,
  isMutating,
  canDeleteTemplate,
  onUse,
  onDelete,
  onPreview,
}: TemplateListProps) => {
  const t = useTranslations();

  if (isPending) {
    return (
      <p className="text-muted-foreground py-6 text-center text-sm">
        {t("common.loading")}
      </p>
    );
  }

  if (!templates || templates.length === 0) {
    return (
      <p className="text-muted-foreground py-6 text-center text-sm">
        {t("workspaces.views.templates.empty")}
      </p>
    );
  }

  return (
    <ScrollArea className="max-h-72">
      <ul className="flex flex-col gap-1">
        {templates.map((template) => (
          <TemplateRow
            canDelete={canDeleteTemplate}
            isPending={isMutating}
            key={template.id}
            onDelete={() => onDelete(template.id)}
            onPreview={() => onPreview(template.layoutType)}
            onUse={() => onUse(template)}
            template={template}
          />
        ))}
      </ul>
    </ScrollArea>
  );
};

type TemplateRowProps = {
  template: WorkspaceViewTemplate;
  canDelete: boolean;
  isPending: boolean;
  onUse: () => void;
  onDelete: () => void;
  onPreview: () => void;
};

const TemplateRow = ({
  template,
  canDelete,
  isPending,
  onUse,
  onDelete,
  onPreview,
}: TemplateRowProps) => {
  const t = useTranslations();
  const Icon = layoutIcons[template.layoutType];

  return (
    <li
      className="hover:bg-muted/50 flex items-center gap-2 rounded p-2"
      onFocus={onPreview}
      onMouseEnter={onPreview}
    >
      <Icon className="text-muted-foreground size-4 shrink-0" />
      <button
        className="min-w-0 flex-1 truncate text-start text-sm"
        disabled={isPending}
        onClick={onUse}
        type="button"
      >
        {template.name}
      </button>
      {canDelete && (
        <DeleteTemplateConfirm
          name={template.name}
          onConfirm={onDelete}
          pending={isPending}
        />
      )}
      <Button
        disabled={isPending}
        onClick={onUse}
        size="xs"
        variant="secondary"
      >
        {t("workspaces.views.templates.use")}
      </Button>
    </li>
  );
};

type DeleteTemplateConfirmProps = {
  name: string;
  pending: boolean;
  onConfirm: () => void;
};

const DeleteTemplateConfirm = ({
  name,
  pending,
  onConfirm,
}: DeleteTemplateConfirmProps) => {
  const t = useTranslations();
  const [open, setOpen] = useState(false);

  return (
    <AlertDialog onOpenChange={setOpen} open={open}>
      <AlertDialogTrigger
        render={
          <Button
            aria-label={t("workspaces.views.templates.delete")}
            disabled={pending}
            size="icon-xs"
            variant="ghost"
          />
        }
      >
        <Trash2Icon />
      </AlertDialogTrigger>
      <AlertDialogPopup>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {t("workspaces.views.templates.delete")}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {t("workspaces.views.templates.deleteConfirmDescription", { name })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogClose render={<Button variant="ghost" />}>
            {t("common.cancel")}
          </AlertDialogClose>
          <AlertDialogClose
            render={
              <Button
                onClick={() => {
                  onConfirm();
                }}
                variant="destructive"
              />
            }
          >
            {t("common.delete")}
          </AlertDialogClose>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
};
