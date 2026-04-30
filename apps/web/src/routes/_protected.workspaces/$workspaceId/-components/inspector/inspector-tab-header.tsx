import type { MouseEvent, ReactNode } from "react";

import { Button } from "@stll/ui/components/button";
import { cn } from "@stll/ui/lib/utils";
import { LayersIcon, XIcon } from "lucide-react";

import { resolveMatterColor } from "@/lib/matter-colors";
import { InlineEdit } from "@/routes/_protected.workspaces/$workspaceId/-components/inline-edit";

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
   * Matter slot rendered after the dot separator. Caller supplies
   * the widget — a navigation link for files, a context picker for
   * chats. Hidden while the label is being renamed to keep the
   * row uncluttered.
   */
  matter?: ReactNode;
  /**
   * Tab-type-specific buttons (zoom controls, edit/save, print,
   * "open in big view", …). Rendered before the universal close.
   */
  actions?: ReactNode;
  onClose: () => void;
};

export const InspectorTabHeader = ({
  label,
  onStartRename,
  onLabelContextMenu,
  rename,
  matter,
  actions,
  onClose,
}: InspectorTabHeaderProps) => (
  <div className="flex h-12 shrink-0 items-center justify-between border-b px-3">
    <div className="flex min-w-0 items-center gap-2 overflow-hidden">
      {rename?.active ? (
        <InlineEdit
          inputClassName="w-40 text-xs"
          onCancel={rename.onCancel}
          onChange={rename.onChange}
          onCommit={rename.onCommit}
          suffix={rename.suffix}
          value={rename.value}
        />
      ) : (
        <span
          className={cn(
            "truncate text-xs font-medium",
            onStartRename !== undefined && "cursor-text",
          )}
          onContextMenu={onLabelContextMenu}
          onDoubleClick={onStartRename}
        >
          {label}
        </span>
      )}
      {matter !== undefined && !rename?.active && (
        <>
          <span aria-hidden="true" className="text-muted-foreground/50 text-xs">
            ·
          </span>
          {matter}
        </>
      )}
    </div>
    <div className="flex shrink-0 items-center gap-1 ps-4">
      {actions}
      <Button onClick={onClose} size="icon-xs" variant="ghost">
        <XIcon className="size-3.5" />
      </Button>
    </div>
  </div>
);

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
}: MatterOriginLinkProps) => {
  const swatch = resolveMatterColor(id, color);
  return (
    <button
      className="text-muted-foreground hover:text-foreground hover:bg-accent inline-flex max-w-[220px] items-center gap-1 truncate rounded-md px-1.5 py-0.5 text-[11px] transition-colors"
      onClick={onClick}
      title={name}
      type="button"
    >
      <LayersIcon
        aria-hidden="true"
        className="size-3 shrink-0"
        style={{ color: swatch }}
      />
      <span className="truncate">{name}</span>
    </button>
  );
};
