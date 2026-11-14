import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import { SignatureIcon } from "@stll/ui/icons";

import type {
  PdfSignFlow,
  PdfSignTarget,
} from "@/components/inspector/pdf-sign-action";
import type {
  LiveOrganizerOperation,
  OrganizerOperationRequest,
} from "@/components/pdf/page-organizer-upload.logic";
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
  /** Closes the editor, so the viewer shows the pages the stamp goes on. */
  closeEditor: () => void;
  disabled: boolean;
  isDirty: boolean;
  beginRequest: (
    operation: LiveOrganizerOperation,
  ) => OrganizerOperationRequest;
  operation: LiveOrganizerOperation;
  /** Saves the page edits as a new version and resolves that version, or `null`. */
  saveVersion: (
    request: OrganizerOperationRequest,
  ) => Promise<PdfSignTarget | null>;
  sign: PageOrganizerSign;
};

/**
 * Sign from the editor footer. Unsaved page edits are saved as a new version
 * first, and that version is signed; with no edits, the open version is.
 * Either way the editor closes and the stamp is placed in the viewer.
 */
export const PageOrganizerSignAction = ({
  closeEditor,
  disabled,
  isDirty,
  beginRequest,
  operation,
  saveVersion,
  sign: { flow: pdfSignFlow, target },
}: PageOrganizerSignActionProps) => {
  const tPageEditor = useTranslations("workspaces.pdf.pageEditor");
  return (
    <CapabilityAction action={{ capability: "desktop" }} surface="control">
      {(capabilityProps) => (
        <Button
          disabled={disabled || pdfSignFlow.isConnecting}
          onClick={() => {
            const request = beginRequest(operation);
            if (isDirty) {
              pdfSignFlow.startWith(async () => {
                const savedTarget = await saveVersion(request);
                if (savedTarget === null) {
                  return null;
                }
                pdfSignFlow.transferToSigning(
                  request,
                  savedTarget,
                  closeEditor,
                  true,
                );
                return null;
              });
              return;
            }
            pdfSignFlow.startWith(async () => {
              pdfSignFlow.transferToSigning(request, target, closeEditor);
              return await Promise.resolve(null);
            });
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
