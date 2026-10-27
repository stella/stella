import { Fragment } from "react";
import type { MouseEvent, ReactNode } from "react";

import { useTranslations } from "use-intl";

import { UserText } from "@stll/ui/bidi-text";
import { Button } from "@stll/ui/button";
import { DirectionalIcon } from "@stll/ui/directional-icon";
import { ArrowLeftIcon, XIcon } from "@stll/ui/icons";
import { MatterIcon } from "@stll/ui/matter-icon";
import { cn } from "@stll/ui/utils";

import { InlineEdit } from "@/components/inline-edit";
import { useInspectorTabsStore } from "@/components/inspector/inspector-tabs-store";
import {
  type Availability,
  filterAvailable,
} from "@/lib/platform/requirements.logic";
import { usePlatformCapabilities } from "@/lib/platform/use-platform-capabilities";

/**
 * Shared header strip used at the top of every inspector tab —
 * file viewers, the chat tab, and any future tab type. Establishes
 * one consistent UX across them: editable name on the left, an
 * optional "· {matter slot}" hint, slot for tab-type-specific
 * actions, and a universal close button on the right.
 *
 * The matter slot is a `ReactNode` (not a {name, onClick} primitive)
 * because different tab types need different behaviour for it:
 * file tabs render a navigation link (the file belongs to one
 * matter, full stop), while chat tabs render a multi-matter
 * context picker so the user can extend the AI's view across
 * matters. The header doesn't dictate either — it just lays out
 * the slot consistently.
 */

/**
 * One tab-type-specific header button. `requires` is mandatory so every
 * action states where it is worth offering; the header drops the ones the
 * device or layout cannot use instead of letting them crowd the name.
 */
export type HeaderAction = {
  /** Stable key, unique within one header. */
  id: string;
  requires: Availability;
  render: () => ReactNode;
};

const NO_HEADER_ACTIONS: readonly HeaderAction[] = [];

type RenameState = {
  /** Whether the label is currently being edited inline. */
  active: boolean;
  /** Controlled value of the inline-edit input. */
  value: string;
  onChange: (value: string) => void;
  /** Persist the rename. Called on Enter or blur. */
  onCommit: () => void;
  /** Discard the rename. Called on Escape. */
  onCancel: () => void;
  /** Optional element appended after the input — e.g. a file extension. */
  suffix?: ReactNode;
  /**
   * Optional action rendered after the input (e.g. the chat tab's
   * title-suggest wand). See `InlineEdit`'s `action` slot for the
   * required press/click trigger semantics.
   */
  action?: ReactNode;
  /** Longest name the rename accepts. */
  maxLength?: number | undefined;
};

type InspectorTabHeaderProps = {
  /**
   * Display label for the tab. Already formatted by the caller
   * (e.g. extension stripped for files, chat title for chats).
   */
  label: string;
  /**
   * Click handler that puts the label into rename mode. When
   * omitted the label is read-only.
   */
  onStartRename?: () => void;
  /**
   * Right-click handler on the label — typically opens a tab
   * context menu so the same actions reachable from the rail
   * (rename, close, close others, close all) are also reachable
   * from the visible label inside the ribbon.
   */
  onLabelContextMenu?: (event: MouseEvent<HTMLElement>) => void;
  /**
   * Inline-edit controls. When `active` is true the input is
   * rendered in place of the label.
   */
  rename?: RenameState;
  /**
   * Matter slot rendered after the dot separator, or under the name
   * on compact layouts. Caller supplies the widget — a navigation
   * link for files, a context picker for chats. Hidden while the
   * label is being renamed to keep the row uncluttered.
   */
  matter?: ReactNode;
  /**
   * Tab-type-specific buttons (zoom controls, edit/save, print,
   * "open in big view", …). Rendered before the universal close.
   * Both are hidden while renaming: the inspector is narrow, and the
   * name needs the whole row to stay readable.
   */
  actions?: readonly HeaderAction[];
  onClose: () => void;
};

export const InspectorTabHeader = ({
  label,
  onStartRename,
  onLabelContextMenu,
  rename,
  matter,
  actions = NO_HEADER_ACTIONS,
  onClose,
}: InspectorTabHeaderProps) => {
  const tCommon = useTranslations("common");
  const setMinimized = useInspectorTabsStore((s) => s.setMinimized);
  const renaming = rename?.active === true;
  const visibleActions = filterAvailable(actions, usePlatformCapabilities());

  return (
    <div className="flex h-12 shrink-0 items-center justify-between border-b bg-(--matter-sidebar-tint) px-3">
      {/* Only the label clips: the field's focus ring is drawn outside it. */}
      <div
        className={cn(
          "flex min-w-0 items-center gap-2",
          !renaming && "overflow-hidden",
        )}
      >
        <Button
          aria-label={tCommon("back")}
          className="-ms-1 md:hidden"
          onClick={() => setMinimized(true)}
          size="icon-sm"
          title={tCommon("back")}
          variant="ghost"
        >
          <DirectionalIcon className="size-4" icon={ArrowLeftIcon} />
        </Button>
        {rename?.active ? (
          <InlineEdit
            className="text-xs font-medium"
            action={rename.action}
            maxLength={rename.maxLength}
            onCancel={rename.onCancel}
            onChange={rename.onChange}
            onCommit={rename.onCommit}
            suffix={rename.suffix}
            value={rename.value}
          />
        ) : (
          // Compact layouts stack the matter under the name, the way a
          // sidebar row puts its client under the matter, so the name gets
          // the whole width instead of sharing one line with the chip.
          <div className="flex min-w-0 flex-col items-start md:flex-row md:items-center md:gap-2">
            <span
              className={cn(
                "max-w-full overflow-hidden text-xs font-medium text-ellipsis whitespace-pre",
                onStartRename !== undefined && "cursor-text",
              )}
              onContextMenu={onLabelContextMenu}
              onDoubleClick={onStartRename}
            >
              <UserText>{label}</UserText>
            </span>
            {matter !== undefined && (
              <>
                <span
                  aria-hidden="true"
                  className="text-foreground-subtle hidden text-xs md:inline"
                >
                  ·
                </span>
                <span className="flex max-w-full min-w-0">{matter}</span>
              </>
            )}
          </div>
        )}
      </div>
      {renaming ? null : (
        <div className="flex shrink-0 items-center gap-1 ps-4">
          {visibleActions.map((action) => (
            <Fragment key={action.id}>{action.render()}</Fragment>
          ))}
          <Button
            aria-label={tCommon("close")}
            onClick={onClose}
            size="icon-xs"
            title={tCommon("close")}
            variant="ghost"
          >
            <XIcon className="size-3.5" />
          </Button>
        </div>
      )}
    </div>
  );
};

/**
 * Standard "matter origin" link for tabs that bind to exactly one
 * matter (file viewers, today). Clicking navigates to the matter
 * overview. Renders the matter's colour-tinted layers icon next
 * to its name so the affordance reads identically to the chat
 * tab's matter picker trigger — same pill, just non-interactive.
 */
type MatterOriginLinkProps = {
  id: string;
  name: string;
  color: string | null;
  onClick: () => void;
};

export const MatterOriginLink = ({
  id,
  name,
  color,
  onClick,
}: MatterOriginLinkProps) => (
  <button
    className="text-muted-foreground hover:text-foreground hover:bg-accent text-2xs inline-flex max-w-[220px] items-center gap-1 truncate rounded-md px-1.5 py-0.5"
    onClick={onClick}
    type="button"
  >
    <MatterIcon className="size-3 shrink-0" matter={{ id, color }} />
    <span className="truncate">{name}</span>
  </button>
);
