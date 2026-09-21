/**
 * The docked composer's geometry and its box, split from the rich chat host so
 * a surface can inherit the exact stack without pulling the editor bundle in
 * with it — the same reason `composer-geometry.ts` sits outside the host.
 */

import type { ComponentProps, ReactNode } from "react";

import {
  COMPOSER_BOX_CLASS,
  COMPOSER_COMPACT_ROW_CLASS,
  COMPOSER_COMPACT_TEXT_CELL_CLASS,
  COMPOSER_TEXT_CLASS,
} from "@stll/ui/composer";
import { OVERLAY_LAYER_CLASS_NAMES } from "@stll/ui/overlay-layer";
import { cn } from "@stll/ui/utils";

import {
  DOCKED_COMPOSER_INSET_START_CLASS,
  DOCKED_COMPOSER_VEIL_WIDTH_CLASS,
  DOCKED_COMPOSER_WIDTH_CLASS,
} from "@/components/ai-suggestions/composer-geometry";
import { ChatComposerActionButton } from "@/components/chat/chat-composer-action-button";
import { ComposerControlSlot } from "@/components/chat/composer-control-slot";
import { ComposerPlusMenu } from "@/components/chat/composer-plus-menu";
import { ComposerVeil } from "@/components/chat/composer-veil";

/**
 * Styled placeholder label rendered in the prompt bar when the editor
 * is empty. Shared between the live `PromptBar` (via `emptyPlaceholder`)
 * and the loading `PromptBarPlaceholder` shell so both surfaces are
 * pixel-identical and can never drift.
 */
export const PromptBarPlaceholderContent = ({
  children,
}: {
  children: ReactNode;
}) => (
  <span
    className={cn(
      "text-foreground-placeholder block min-w-0 truncate",
      COMPOSER_TEXT_CLASS,
    )}
  >
    {children}
  </span>
);

type PromptBarShellProps = {
  children: ReactNode;
} & Omit<ComponentProps<"div">, "children">;

/**
 * Background for chrome floating over the document page (prompt bar,
 * suggestion stepper, preset chips). In light mode the rendered page
 * reads as white paper in every accent palette, while `--popover`
 * follows the palette (Flexoki `#fffcf0`, Nord `#eceff4`) — solid but
 * visibly hue-tinted against the document. Anchor these surfaces to
 * the document instead: white in light; in dark the page follows the
 * theme, so the popover token stays correct. (`--doc-canvas` itself
 * is scoped to `.folio-root` and does not reach these elements.)
 */
export const DOC_FLOAT_SURFACE_CLASS =
  "[--doc-float-surface:var(--color-white)] dark:[--doc-float-surface:var(--popover)] bg-(--doc-float-surface)";

/**
 * The bar box itself — the shared composer box (same radius, border, focus
 * ring and compact row stature as the main chat bar), plus the shadow and
 * doc-anchored surface a bar floating over a document needs — with no
 * positioning or sizing of its own. `DockedComposer` owns where the bar sits
 * and how wide it is; this shell just paints the box and fills the width it
 * is given (`w-full`). Both the live `PromptBar` and the loading
 * `PromptBarPlaceholder` render through it so they can never drift apart.
 *
 * The surface is solid on purpose: the separate pane veil softens document
 * content around the stack while the controls themselves remain crisp.
 */
export const PromptBarShell = ({
  children,
  className,
  ...rest
}: PromptBarShellProps) => (
  <div
    {...rest}
    className={cn(
      COMPOSER_BOX_CLASS,
      "group/bar relative flex w-full transition-[box-shadow,border-color]",
      COMPOSER_COMPACT_ROW_CLASS,
      "shadow-floating-ring",
      DOC_FLOAT_SURFACE_CLASS,
      className,
    )}
  >
    {children}
  </div>
);

/**
 * What a bar that is drawn but cannot be typed into does when it is pressed.
 * Absent while the live editor hydrates (nothing to say yet); present where
 * the bar is the entry point to something the reader does not have an account
 * for, so the press is what asks for one.
 */
type PromptBarActivation = {
  /** Names the act for a screen reader; the bar itself only shows a hint. */
  label: string;
  onActivate: () => void;
};

/**
 * Complete prompt row rendered while the live editor hydrates. Known controls
 * stay real and fixed in place; only data-owned content belongs in a skeleton.
 * Keeping this beside `PromptBar` makes the attachment and send affordances a
 * single owned pair instead of asking each loading shell to mirror them.
 *
 * With an `activation` the same row becomes pressable: the controls stay inert
 * and one transparent button covers the box, so the reader presses the bar
 * they can see rather than a control that only looks enabled.
 */
export const PromptBarPending = ({
  activation,
  children,
}: {
  activation?: PromptBarActivation | undefined;
  children: ReactNode;
}) => (
  <PromptBarShell
    {...(activation === undefined ? { "aria-hidden": true } : {})}
  >
    <ComposerControlSlot>
      <ComposerPlusMenu disabled onOpenFilePicker={() => undefined} />
    </ComposerControlSlot>
    <div
      className={cn(
        COMPOSER_COMPACT_TEXT_CELL_CLASS,
        "flex flex-1 items-center px-1.5",
      )}
    >
      <PromptBarPlaceholderContent>{children}</PromptBarPlaceholderContent>
    </div>
    <ComposerControlSlot>
      <ChatComposerActionButton
        canSend={false}
        isGenerating={false}
        onSend={() => undefined}
      />
    </ComposerControlSlot>
    {activation !== undefined && (
      <button
        aria-label={activation.label}
        className="absolute inset-0 cursor-text rounded-[inherit]"
        onClick={activation.onActivate}
        type="button"
      />
    )}
  </PromptBarShell>
);

type DockedComposerProps = {
  /**
   * Follow-up chips stacked directly above the bar. Owns no offset of
   * its own — the chips component carries its own bottom spacing and
   * collapses to nothing when it has nothing to show, so no phantom gap
   * appears above the bar.
   */
  chips?: ReactNode;
  /** The prompt bar itself (a `PromptBarShell`). */
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
export const DockedComposer = ({ chips, bar, dock }: DockedComposerProps) => (
  <div
    className={cn(
      "pointer-events-none absolute inset-x-0 bottom-3.5 flex flex-col items-center",
      DOCKED_COMPOSER_INSET_START_CLASS,
      OVERLAY_LAYER_CLASS_NAMES.chrome,
    )}
  >
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
    >
      {bar}
      {/* No extra top margin: `ComposerStatusRow` owns the single
            bar-to-row gap (mt-1.5), matching the main chat tray's rhythm. */}
      {dock !== undefined && <div className="px-1">{dock}</div>}
    </div>
  </div>
);
