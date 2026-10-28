import { useLayoutEffect, useRef } from "react";

import { useTranslations } from "use-intl";

import { SignatureIcon } from "@stll/ui/icons";
import { ToolbarIconAction } from "@stll/ui/toolbar-icon-action";

import { openInspectorFilePreview } from "@/components/inspector/inspector-actions";
import {
  beginPdfSignPlacement,
  endPdfSignPlacement,
  usePdfSignPlacementStore,
} from "@/components/inspector/pdf-sign-placement-store";
import type { PdfSignableFile } from "@/components/inspector/pdf-signing";
import { useDesktopPdfSign } from "@/components/inspector/use-desktop-pdf-sign";
import {
  consumeOrganizerOperationRequest,
  type OrganizerOperationRequest,
} from "@/components/pdf/page-organizer-upload.logic";
import {
  DesktopRequiredDialog,
  useDesktopActionGate,
} from "@/features/desktop/desktop-action-gate";
import type { DesktopRequiredDialogProps } from "@/features/desktop/desktop-action-gate";
import type {
  DesktopActionStatus,
  DesktopSetupStep,
} from "@/features/desktop/desktop-action-gate.logic";
import { detachedUserAction } from "@/lib/errors/user-toast";
import { CapabilityAction } from "@/lib/organization/feature-access/capability-actions";
import type { WorkspaceEntity } from "@/lib/types";

export type PdfSignTarget = PdfSignableFile;

export type PdfSignFlow = {
  /** What the action does in the current desktop presence, or that it runs. */
  label: string;
  /** The action itself, for surfaces that show the desktop status beside it. */
  actionLabel: string;
  status: DesktopActionStatus;
  setUp: (step: DesktopSetupStep) => void;
  isConnecting: boolean;
  /** A signing exchange is open in stella desktop. */
  isSigning: boolean;
  /**
   * Once stella desktop can sign, start placing the stamp on `target`'s
   * pages in the viewer that shows it. `reveal` brings that viewer on screen
   * when the action was offered somewhere else (a row menu, the page editor).
   */
  start: (target: PdfSignTarget, reveal?: () => void) => void;
  /**
   * Like `start`, but once stella desktop can sign, first runs `prepare` and
   * places the stamp on the file it resolves (a version it just saved, say).
   * `null` stops without signing; `prepare` reports its own failures.
   */
  startWith: (prepare: () => Promise<PdfSignTarget | null>) => void;
  transferToSigning: (
    request: OrganizerOperationRequest,
    target: PdfSignTarget,
    reveal?: () => void,
  ) => boolean;
  requiredDialog: DesktopRequiredDialogProps;
};

/**
 * The sign action's state, kept by whoever outlives the trigger: a menu item
 * unmounts with its menu, so the row menu holds the flow beside the menu and
 * renders {@link PdfSignRequiredDialog} there. The stamp is placed on the
 * page in the PDF viewer; confirming it there hands the file to stella
 * desktop through this flow.
 */
export const usePdfSignFlow = (
  activeDocumentId: string | undefined,
): PdfSignFlow => {
  const t = useTranslations();
  const gate = useDesktopActionGate("sign-pdf");
  const signing = useDesktopPdfSign({ connectDesktop: gate.connect });
  const sessionRef = useRef<SigningAuthority | null>(null);
  const activeDocumentIdRef = useRef(activeDocumentId);
  useLayoutEffect(() => {
    activeDocumentIdRef.current = activeDocumentId;
    const session = sessionRef.current;
    if (
      session !== null &&
      (activeDocumentId === undefined ||
        activeDocumentId !== session.documentId)
    ) {
      session.cancelled = true;
      sessionRef.current = null;
      endPdfSignPlacement();
    }
    return () => {
      activeDocumentIdRef.current = undefined;
      const ownedSession = sessionRef.current;
      if (ownedSession !== null) {
        ownedSession.cancelled = true;
        sessionRef.current = null;
        endPdfSignPlacement();
      }
    };
  }, [activeDocumentId]);
  const run = (perform: () => void) => {
    if (signing.isSigning) {
      signing.notifyAlreadySigning();
      return;
    }
    gate.run(perform);
  };
  const place = (
    target: PdfSignTarget,
    authority = createAuthority(target),
  ) => {
    sessionRef.current = authority;
    const isCurrent = () =>
      sessionRef.current === authority &&
      !authority.cancelled &&
      activeDocumentIdRef.current === authority.documentId;
    const cancel = () => {
      authority.cancelled = true;
      if (sessionRef.current === authority) {
        sessionRef.current = null;
      }
    };
    beginPdfSignPlacement({
      cancel,
      confirm: (stamp) => {
        if (!isCurrent()) {
          return;
        }
        detachedUserAction(
          signing.sign({
            authority: isCurrent,
            cancelAuthority: cancel,
            stamp,
            target,
          }),
          {
            context: "pdf-sign-action.sign",
            failureMessage: t("workspaces.files.pdfSigning.startFailedTitle"),
          },
        );
      },
      fieldId: target.fieldId,
      isCurrent,
    });
  };
  return {
    label: signing.isSigning
      ? t("workspaces.files.pdfSigning.signingLabel")
      : gate.label,
    actionLabel: signing.isSigning
      ? t("workspaces.files.pdfSigning.signingLabel")
      : t("workspaces.files.pdfSigning.placementTitle"),
    status: gate.status,
    setUp: gate.setUp,
    isConnecting: gate.isConnecting,
    isSigning: signing.isSigning,
    start: (target, reveal) => {
      run(() => {
        place(target);
        reveal?.();
      });
    },
    startWith: (prepare) => {
      run(() => {
        detachedUserAction(
          (async () => {
            const target = await prepare();
            if (target === null) {
              return;
            }
            place(target);
          })(),
          {
            context: "pdf-sign-action.prepare",
            failureMessage: t("workspaces.files.pdfSigning.startFailedTitle"),
          },
        );
      });
    },
    transferToSigning: (request, target, reveal) => {
      if (!consumeOrganizerOperationRequest(request)) {
        return false;
      }
      place(target);
      reveal?.();
      return true;
    },
    requiredDialog: gate.requiredDialog,
  };
};

type SigningAuthority = {
  cancelled: boolean;
  documentId: string;
  id: symbol;
};
const createAuthority = (target: PdfSignTarget): SigningAuthority => ({
  cancelled: false,
  documentId: target.entityId,
  id: Symbol("pdf-signing-session"),
});

type PdfSignFromListOptions = {
  entity: WorkspaceEntity;
  /** `null` when the row offers no signing. */
  target: PdfSignTarget | null;
  workspaceId: string;
};

/**
 * Signing offered on a list row. The stamp is placed on the page, so `sign`
 * shows the file in the inspector beside the list and places it there. The
 * list stays on screen, and with it the row that holds this flow, so the
 * row's action reads as signing until stella desktop settles the exchange.
 */
export const usePdfSignFromList = ({
  entity,
  target,
  workspaceId,
}: PdfSignFromListOptions) => {
  const flow = usePdfSignFlow(target?.entityId);
  const sign = () => {
    if (target === null) {
      return;
    }
    flow.start(target, () => {
      openInspectorFilePreview({
        entity,
        fieldId: target.fieldId,
        workspaceId,
      });
    });
  };
  return { flow, sign };
};

/** What stella desktop needs before it can sign: install, update or connect. */
export const PdfSignRequiredDialog = ({ flow }: { flow: PdfSignFlow }) => (
  <DesktopRequiredDialog {...flow.requiredDialog} />
);

type PdfSignButtonProps = {
  target: PdfSignTarget;
};

/**
 * The viewer's sign action: it switches the viewer of `target` into stamp
 * placement and, pressed again while placing, back out of it.
 */
export const PdfSignButton = ({ target }: PdfSignButtonProps) => {
  const flow = usePdfSignFlow(target.entityId);
  const isPlacing = usePdfSignPlacementStore(
    (state) => state.session?.fieldId === target.fieldId,
  );
  return (
    <>
      <CapabilityAction action={{ capability: "desktop" }} surface="control">
        {(capabilityProps) => (
          <ToolbarIconAction
            aria-pressed={isPlacing}
            data-pressed={isPlacing ? "" : undefined}
            density="toolbar"
            disabled={flow.isConnecting}
            icon={<SignatureIcon className="size-3.5" />}
            label={flow.label}
            onClick={() => {
              if (isPlacing) {
                endPdfSignPlacement();
                return;
              }
              flow.start(target);
            }}
            {...capabilityProps}
          />
        )}
      </CapabilityAction>
      <PdfSignRequiredDialog flow={flow} />
    </>
  );
};
