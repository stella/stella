import { useCallback, useRef, useState } from "react";

import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "@stll/ui/components/alert-dialog";
import { Button } from "@stll/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@stll/ui/components/menu";
import { stellaToast } from "@stll/ui/components/toast";
import {
  LayoutTemplateIcon,
  MoreHorizontalIcon,
  PlusIcon,
  Trash2Icon,
} from "lucide-react";
import { useFormatter, useTranslations } from "use-intl";

import { usePermissions } from "@/hooks/use-permissions";
import { api } from "@/lib/api";
import { DOCX_MIME } from "@/lib/consts";
import { userErrorMessage } from "@/lib/errors";
import { TemplateCategorySidebar } from "@/routes/_protected.knowledge/-components/template-category-sidebar";
import type { TemplateCategoryItem } from "@/routes/_protected.knowledge/-components/template-category-sidebar";
import { TemplateUpload } from "@/routes/_protected.knowledge/-components/template-upload";

type DiscoverResponse = Awaited<ReturnType<typeof api.templates.discover.post>>;

type DiscoverData = Exclude<
  NonNullable<Extract<DiscoverResponse, { data: unknown }>["data"]>,
  Response
>;

type TemplateItem = {
  id: string;
  name: string;
  fileName: string;
  fieldCount: number;
  sizeBytes: number;
  categoryId: string | null;
  createdAt: Date;
};

type TemplateListProps = {
  templates: TemplateItem[];
  categories: TemplateCategoryItem[];
  selectedCategoryId: string | null;
  onCategorySelect: (id: string | null) => void;
  onCategoriesChanged: () => void;
  onDiscovered: (file: File, schema: DiscoverData) => void;
  onSelect: (template: TemplateItem) => void;
  onDeleted: () => void;
};

export const TemplateList = ({
  templates,
  categories,
  selectedCategoryId,
  onCategorySelect,
  onCategoriesChanged,
  onDiscovered,
  onSelect,
  onDeleted,
}: TemplateListProps) => {
  const t = useTranslations();
  const canCreateTemplate = usePermissions({ template: ["create"] });
  const inputRef = useRef<HTMLInputElement>(null);
  const [discovering, setDiscovering] = useState(false);

  const discover = useCallback(
    async (file: File) => {
      if (file.type !== DOCX_MIME) {
        stellaToast.add({
          type: "error",
          title: t("templates.invalidFileType"),
        });
        return;
      }

      setDiscovering(true);
      const response = await api.templates.discover.post({ file });
      setDiscovering(false);

      if (response.error) {
        stellaToast.add({
          type: "error",
          title: t("templates.discoveryFailed"),
          description: userErrorMessage(
            response.error,
            t("common.unexpectedError"),
          ),
        });
        return;
      }

      const { data } = response;
      if (data instanceof Response) {
        stellaToast.add({
          type: "error",
          title: t("templates.discoveryFailed"),
        });
        return;
      }

      onDiscovered(file, data);
    },
    [onDiscovered, t],
  );

  const handleFileChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.item(0);
      if (file) {
        // Errors are surfaced as toasts inside discover
        // TODO: fix this
        // oxlint-disable-next-line no-empty-function
        discover(file).catch(() => {});
      }
      e.target.value = "";
    },
    [discover],
  );

  if (templates.length === 0 && !selectedCategoryId) {
    return <TemplateUpload onDiscovered={onDiscovered} />;
  }

  return (
    <div className="flex min-h-0 flex-1">
      <TemplateCategorySidebar
        categories={categories}
        onCategoriesChanged={onCategoriesChanged}
        onSelect={onCategorySelect}
        selectedId={selectedCategoryId}
      />

      <div className="flex min-h-0 flex-1 flex-col border-s">
        <div className="flex items-center justify-between border-b px-4 py-2">
          <span className="text-muted-foreground text-sm">
            {String(templates.length)}
          </span>
          {canCreateTemplate && (
            <>
              <Button
                disabled={discovering}
                onClick={() => inputRef.current?.click()}
                size="sm"
              >
                <PlusIcon />
                {discovering
                  ? t("templates.discovering")
                  : t("templates.newTemplate")}
              </Button>
              <input
                accept=".docx"
                className="hidden"
                onChange={handleFileChange}
                ref={inputRef}
                type="file"
              />
            </>
          )}
        </div>

        <div className="flex-1 overflow-y-auto">
          {templates.length === 0 && (
            <div className="flex items-center justify-center p-8">
              <p className="text-muted-foreground text-sm">
                {t("templates.noTemplates")}
              </p>
            </div>
          )}

          <ul className="divide-y">
            {templates.map((template) => (
              <TemplateRow
                key={template.id}
                onDeleted={onDeleted}
                onSelect={() => onSelect(template)}
                template={template}
              />
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
};

const TemplateRow = ({
  template,
  onSelect,
  onDeleted,
}: {
  template: TemplateItem;
  onSelect: () => void;
  onDeleted: () => void;
}) => {
  const t = useTranslations();
  const canDeleteTemplate = usePermissions({ template: ["delete"] });
  const format = useFormatter();
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const handleDelete = useCallback(async () => {
    setDeleting(true);
    const response = await api
      .templates({
        templateId: template.id,
      })
      .delete();

    setDeleting(false);

    if (response.error) {
      stellaToast.add({
        type: "error",
        title: t("templates.deleteFailed"),
        description: userErrorMessage(
          response.error,
          t("common.unexpectedError"),
        ),
      });
      return;
    }

    stellaToast.add({
      type: "success",
      title: t("templates.templateDeleted"),
    });
    setDeleteOpen(false);
    onDeleted();
  }, [template.id, t, onDeleted]);

  return (
    <li className="flex items-center gap-4 px-4 py-3">
      <button
        className="flex min-w-0 flex-1 items-center gap-3 text-start hover:opacity-80"
        onClick={onSelect}
        type="button"
      >
        <div className="bg-muted flex size-9 shrink-0 items-center justify-center rounded-lg">
          <LayoutTemplateIcon className="text-muted-foreground size-4" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{template.name}</p>
          <p className="text-muted-foreground text-xs">
            {t("templates.fieldCount", {
              count: template.fieldCount,
            })}
            {" \u00b7 "}
            {format.dateTime(new Date(template.createdAt), {
              dateStyle: "medium",
            })}
          </p>
        </div>
      </button>

      {canDeleteTemplate && (
        <AlertDialog onOpenChange={setDeleteOpen} open={deleteOpen}>
          <DropdownMenu>
            <DropdownMenuTrigger
              render={<Button size="icon-xs" variant="ghost" />}
            >
              <MoreHorizontalIcon />
            </DropdownMenuTrigger>
            <DropdownMenuContent>
              <DropdownMenuItem
                className="text-destructive-foreground"
                onClick={() => setDeleteOpen(true)}
              >
                <Trash2Icon />
                {t("common.delete")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          <AlertDialogPopup>
            <AlertDialogHeader>
              <AlertDialogTitle>{t("common.delete")}</AlertDialogTitle>
              <AlertDialogDescription>
                {t("templates.confirmDelete")}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogClose render={<Button variant="ghost" />}>
                {t("common.cancel")}
              </AlertDialogClose>
              <Button
                disabled={deleting}
                onClick={() => {
                  void handleDelete();
                }}
                variant="destructive"
              >
                {t("common.delete")}
              </Button>
            </AlertDialogFooter>
          </AlertDialogPopup>
        </AlertDialog>
      )}
    </li>
  );
};
