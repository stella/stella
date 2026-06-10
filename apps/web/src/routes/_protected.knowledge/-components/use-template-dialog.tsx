import { useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "use-intl";

import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "@stll/ui/components/dialog";

import { TemplateForm } from "@/routes/_protected.knowledge/-components/template-form";
import { useTemplateFillSchema } from "@/routes/_protected.knowledge/-components/use-template-fill-schema";
import { entitiesKeys } from "@/routes/_protected.workspaces/$workspaceId/-queries/entities";

/**
 * "Use template" from the Knowledge templates list: fill the saved template
 * and either download the result (DOCX/PDF) or save it straight into a
 * matter the user picks. AI prefill from source documents is available at
 * the top of the form.
 */

type UseTemplateDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  templateId: string;
  templateName: string;
};

export const UseTemplateDialog = ({
  open,
  onOpenChange,
  templateId,
  templateName,
}: UseTemplateDialogProps) => (
  <Dialog onOpenChange={onOpenChange} open={open}>
    {/* Mount only while open so each open starts from a blank form. */}
    {open ? (
      <UseTemplateDialogBody
        onOpenChange={onOpenChange}
        templateId={templateId}
        templateName={templateName}
      />
    ) : null}
  </Dialog>
);

const UseTemplateDialogBody = ({
  onOpenChange,
  templateId,
  templateName,
}: Omit<UseTemplateDialogProps, "open">) => {
  const t = useTranslations();
  const queryClient = useQueryClient();
  const fill = useTemplateFillSchema(templateId);

  return (
    <DialogPopup className="sm:max-w-3xl">
      <DialogHeader>
        <DialogTitle>{templateName}</DialogTitle>
        <DialogDescription>{t("templates.useTemplateHint")}</DialogDescription>
      </DialogHeader>
      <DialogPanel className="flex max-h-[70vh] min-h-48 flex-col overflow-hidden p-0">
        {fill.state === "loading" && (
          <p className="text-muted-foreground p-6 text-sm">
            {t("common.loading")}
          </p>
        )}
        {fill.state === "error" && (
          <p className="text-muted-foreground p-6 text-sm">
            {t("templates.loadFailed")}
          </p>
        )}
        {fill.state === "ready" && (
          <TemplateForm
            conditions={fill.schema.conditions}
            fields={fill.schema.fields}
            fileName={fill.fileName}
            onBack={() => undefined}
            onDone={() => undefined}
            prefill={{}}
            saveTarget={{
              kind: "chooseMatter",
              onCreated: ({ workspaceId }) => {
                queryClient
                  .invalidateQueries({
                    queryKey: entitiesKeys.all(workspaceId),
                  })
                  .catch(() => {
                    /* fire-and-forget */
                  });
                onOpenChange(false);
              },
            }}
            structureErrors={fill.schema.structureErrors}
            templateId={templateId}
          />
        )}
      </DialogPanel>
    </DialogPopup>
  );
};
