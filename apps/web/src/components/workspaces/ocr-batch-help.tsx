import type { ReactElement } from "react";

import { useTranslations } from "use-intl";

import { DOCUMENT_OCR_AVAILABILITY } from "@stll/api-contract/document-ocr-availability";
import { CircleHelpIcon } from "@stll/ui/icons";
import { MenuItem } from "@stll/ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "@stll/ui/tooltip";

import { useActionCapabilities } from "@/lib/organization/feature-access/capability-actions";

/**
 * Puts a help item after an OCR menu row while queued requests wait for the
 * next batch. The help is its own menu item, so arrow keys reach it and
 * screen readers read the text as its name, and pressing it neither runs the
 * row's action nor closes the menu. The app tooltip wrapper keeps text on one
 * line, so the sentence uses the primitive, which wraps.
 */
export const WithOcrBatchHelp = ({ children }: { children: ReactElement }) => {
  const t = useTranslations();
  const { documentOcr } = useActionCapabilities("ocr");
  if (documentOcr?.type !== DOCUMENT_OCR_AVAILABILITY.batched.type) {
    return children;
  }
  const help = t("workspaces.files.ocrBatchHelp");
  return (
    <div className="flex items-center">
      {children}
      <Tooltip>
        <TooltipTrigger
          render={
            <MenuItem
              aria-label={help}
              className="shrink-0"
              closeOnClick={false}
            />
          }
        >
          <CircleHelpIcon />
        </TooltipTrigger>
        <TooltipPopup className="max-w-70">{help}</TooltipPopup>
      </Tooltip>
    </div>
  );
};
