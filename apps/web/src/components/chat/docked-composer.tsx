/**
 * The docked composer's geometry and its pending bar, split from the rich chat
 * host so a surface can inherit the exact stack without pulling the editor
 * bundle in with it — the same reason `composer-geometry.ts` sits outside the
 * host. The bar itself is a `ComposerFrame` on the document surface.
 */

import type { ReactNode } from "react";

import { useTranslations } from "use-intl";

import { COMPOSER_TEXT_CLASS } from "@stll/ui/composer";
import { ComposerFrame } from "@stll/ui/composer-frame";
import { OVERLAY_LAYER_CLASS_NAMES } from "@stll/ui/overlay-layer";
import { publishDocumentPanelInset } from "@stll/ui/panel-inset";
import { TruncatedText } from "@stll/ui/truncated-text";
import { cn } from "@stll/ui/utils";

import {
  DOCKED_COMPOSER_INSET_START_CLASS,
  DOCKED_COMPOSER_VEIL_WIDTH_CLASS,
  DOCKED_COMPOSER_WIDTH_CLASS,
} from "@/components/ai-suggestions/composer-geometry";
import {
  ComposerPlusFace,
  ComposerSendFace,
} from "@/components/chat/composer-row.pending";
import { ComposerVeil } from "@/components/chat/composer-veil.pending";
import {
  DOCKED_CHAT_COLUMN_SLOT,
  useDockedChatSlotRef,
} from "@/components/chat/docked-chat-stack";

/**
 * Styled placeholder label rendered in the prompt bar when the editor
 * is empty. Shared between the live `PromptBar` (via `emptyPlaceholder`)
 * and the loading `PromptBarPending` so both surfaces are pixel-identical
 * and can never drift.
 */
export const PromptBarPlaceholderContent = ({
  children,
}: {
  children: ReactNode;
}) => (
  <TruncatedText
    render={
      <span
        className={cn("text-foreground-placeholder", COMPOSER_TEXT_CLASS)}
      />
    }
  >
    {children}
  </TruncatedText>
);

/**
 * Complete prompt row rendered while the live editor hydrates. Known controls
 * keep their place in their unavailable faces, drawn from the chat bar's own
 * pieces (`composer-row.pending`), the ones the chat thread's loading view
 * uses too; only data-owned content belongs in a skeleton.
 */
export const PromptBarPending = ({ children }: { children: ReactNode }) => (
  <ComposerFrame
    aria-hidden
    empty
    leading={<ComposerPlusFace />}
    placeholder={
      <PromptBarPlaceholderContent>{children}</PromptBarPlaceholderContent>
    }
    ring="none"
    stature="compact"
    surface="document"
    text={null}
    trailing={<ComposerSendFace />}
  />
);

/**
 * The docked composer while its code or thread loads, at the height of what is
 * coming: the chat's bar and status row, or the sign-in bar. The composer
 * publishes the height everything else on the page lays out around, so it holds
 * that height from the first paint instead of leaving and coming back.
 */
export const DockedComposerPending = ({
  surface,
}: {
  surface: "chat" | "sign-in";
}) => {
  const t = useTranslations("common");
  return (
    <>
      {/* The placeholder is hidden from assistive technology; this says why. */}
      <span className="sr-only" role="status">
        {t("loading")}
      </span>
      {surface === "chat" ? (
        <DockedComposer
          bar={<PromptBarPending>{null}</PromptBarPending>}
          // The status row's height: its controls, and the gap above them.
          dock={<div aria-hidden className="mt-1.5 h-6" />}
        />
      ) : (
        <DockedComposer
          bar={
            <ComposerFrame
              aria-hidden
              empty
              ring="none"
              stature="compact"
              surface="document"
              text={null}
            />
          }
        />
      )}
    </>
  );
};

type DockedComposerProps = {
  /**
   * Follow-up chips stacked directly above the bar. Owns no offset of
   * its own — the chips component carries its own bottom spacing and
   * collapses to nothing when it has nothing to show, so no phantom gap
   * appears above the bar.
   */
  chips?: ReactNode;
  /** The prompt bar itself (a `ComposerFrame` on the document surface). */
  bar: ReactNode;
  /**
   * Status row beneath the bar (matter picker, context meter, send-mode
   * shield). Anchored flush under the bar with the single owned gap.
   */
  dock?: ReactNode;
};

/**
 * The one and only owner of the docked-composer geometry.
 *
 * Every chat surface — the inspector chat tab, the file-overlay chat,
 * the Template Studio chat — mounts its `PromptBar` through this, so the
 * bar's width, its bottom offset from the host pane, the follow-up-chip
 * offset, and the status-row placement live in exactly one place and can
 * never drift between surfaces. The column pins to the bottom of the
 * nearest positioned host pane and centres itself; the wrapper is
 * click-through so scrolled content behind the composer stays reachable
 * in the gaps, while the bar, chips, and dock capture their own clicks.
 *
 * The bar sits above a surface's own thread panel (z-50 vs the panel's
 * z-40) so the two never fight where they meet, and the chips sit below
 * it (z-30) so an open thread wins the overlap.
 */
export const DockedComposer = ({ chips, bar, dock }: DockedComposerProps) => {
  const threadSlotRef = useDockedChatSlotRef("thread");
  const reviewSlotRef = useDockedChatSlotRef("review");
  return (
    <div
      className={cn(
        "pointer-events-none absolute inset-x-0 bottom-3.5 flex flex-col items-center",
        DOCKED_COMPOSER_INSET_START_CLASS,
        OVERLAY_LAYER_CLASS_NAMES.chrome,
      )}
      data-slot={DOCKED_CHAT_COLUMN_SLOT}
      ref={publishDocumentPanelInset}
    >
      {/* The docked surfaces of this host (thread card, review pill) render
          into these slots: same column, same width, stacked on the bar with
          one gap, so they cannot drift from the composer on any route. They
          sit outside the veil's box, which belongs to the composer alone. */}
      <div
        className={cn(
          "pointer-events-auto relative z-40 mb-2 empty:hidden",
          DOCKED_COMPOSER_WIDTH_CLASS,
        )}
        data-slot="docked-chat-thread"
        ref={threadSlotRef}
      />
      <div
        className={cn(
          "pointer-events-auto relative mb-2 empty:hidden",
          DOCKED_COMPOSER_WIDTH_CLASS,
        )}
        data-slot="docked-chat-review"
        ref={reviewSlotRef}
      />
      <div className="relative flex w-full flex-col items-center">
        <ComposerVeil
          className={cn("mx-auto", DOCKED_COMPOSER_VEIL_WIDTH_CLASS)}
          variant="pane"
        />
        {chips !== undefined && (
          <div
            className={cn(
              "pointer-events-auto relative z-30 px-1",
              DOCKED_COMPOSER_WIDTH_CLASS,
            )}
          >
            {chips}
          </div>
        )}
        <div
          className={cn(
            "pointer-events-auto relative z-50 flex flex-col",
            DOCKED_COMPOSER_WIDTH_CLASS,
          )}
          data-slot="docked-chat-composer"
        >
          {bar}
          {/* No extra top margin: `ComposerStatusRow` owns the single
                bar-to-row gap (mt-1.5), matching the main chat tray's rhythm. */}
          {dock !== undefined && <div className="px-1">{dock}</div>}
        </div>
      </div>
    </div>
  );
};
