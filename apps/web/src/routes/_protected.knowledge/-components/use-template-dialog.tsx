import { useTranslations } from "use-intl";

import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "@stll/ui/components/dialog";

import {
  TemplateForm,
  useFillToMatterSaveTarget,
} from "@/routes/_protected.knowledge/-components/template-form";
import { useTemplateFillSchema } from "@/routes/_protected.knowledge/-components/use-template-fill-schema";

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
  const fill = useTemplateFillSchema(templateId);
  // Fill into a matter the user picks, then open the result editable.
  const saveTarget = useFillToMatterSaveTarget(() => onOpenChange(false));

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
            saveTarget={saveTarget}
            structureErrors={fill.schema.structureErrors}
            templateId={templateId}
          />
        )}
      </DialogPanel>
    </DialogPopup>
  );
};
