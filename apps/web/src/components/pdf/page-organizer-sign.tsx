import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import { SignatureIcon } from "@stll/ui/icons";

import type {
  PdfSignFlow,
  PdfSignTarget,
} from "@/components/inspector/pdf-sign-action";
import { CapabilityAction } from "@/lib/organization/feature-access/capability-actions";

/**
 * Signing offered inside the page editor. The flow belongs to whoever
 * outlives the editor, because saving first replaces the editor's document.
 */
export type PageOrganizerSign = {
  flow: PdfSignFlow;
  /** The version the editor opened, resolved like every other sign entry point. */
  target: PdfSignTarget;
};

type PageOrganizerSignActionProps = {
  disabled: boolean;
  isDirty: boolean;
  /** Saves the page edits as a new version and resolves that version, or `null`. */
  saveVersion: () => Promise<PdfSignTarget | null>;
  sign: PageOrganizerSign;
};

/**
 * Sign from the editor footer. Unsaved page edits are saved as a new version
 * first, and that version is signed; with no edits, the open version is.
 */
export const PageOrganizerSignAction = ({
  disabled,
  isDirty,
  saveVersion,
  sign: { flow: pdfSignFlow },
}: PageOrganizerSignActionProps) => {
  const tPageEditor = useTranslations("workspaces.pdf.pageEditor");
  return (
    <CapabilityAction action={{ capability: "desktop" }} surface="control">
      {(capabilityProps) => (
        <Button
          disabled={disabled || pdfSignFlow.isConnecting}
          onClick={() => {
            if (isDirty) {
              pdfSignFlow.startWith(saveVersion);
              return;
            }
            pdfSignFlow.start();
          }}
          size="sm"
          {...(isDirty ? { tooltip: tPageEditor("signAfterSave") } : {})}
          variant="outline"
          {...capabilityProps}
        >
          <SignatureIcon />
          {pdfSignFlow.label}
        </Button>
      )}
    </CapabilityAction>
  );
};
