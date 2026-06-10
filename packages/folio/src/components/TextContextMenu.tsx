/**
 * Text Context Menu Component
 *
 * Right-click context menu for text editing operations.
 * Shows Cut, Copy, Paste, and other text editing options.
 */

import React, { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import {
  ArrowDownToLine as ArrowDownToLineIcon,
  ArrowLeftToLine as ArrowLeftToLineIcon,
  ArrowRightToLine as ArrowRightToLineIcon,
  ArrowUpToLine as ArrowUpToLineIcon,
  ClipboardPaste as ClipboardPasteIcon,
  Copy as CopyIcon,
  Grid3x3 as Grid3x3Icon,
  MessageSquarePlus as MessageSquarePlusIcon,
  Scissors as ScissorsIcon,
  SquareDashed as SquareDashedIcon,
  TextSelect as TextSelectIcon,
  Trash2 as Trash2Icon,
} from "lucide-react";

// ============================================================================
// TYPES
// ============================================================================

/**
 * Context menu action types
 */
export type TextContextAction =
  | "cut"
  | "copy"
  | "paste"
  | "pasteAsPlainText"
  | "selectAll"
  | "delete"
  | "separator"
  | "addRowAbove"
  | "addRowBelow"
  | "deleteRow"
  | "addColumnLeft"
  | "addColumnRight"
  | "deleteColumn"
  | "tableBordersAll"
  | "tableBordersNone"
  | "addComment"
  | "acceptChange"
  | "rejectChange"
  | `custom:${string}`;

/** Built-in actions — everything except host-provided `custom:*` entries. */
type BuiltInTextContextAction = Exclude<TextContextAction, `custom:${string}`>;

const isBuiltInAction = (
  action: TextContextAction,
): action is BuiltInTextContextAction => !action.startsWith("custom:");

/**
 * Menu item configuration
 */
export type TextContextMenuItem = {
  /** Action type */
  action: TextContextAction;
  /** Display label */
  label: string;
  /** Keyboard shortcut hint */
  shortcut?: string;
  /** Whether the item is disabled */
  disabled?: boolean;
  /** Whether to show divider after this item */
  dividerAfter?: boolean;
  /** Icon override (host-provided entries pass their own lucide icon). */
  icon?: React.ReactNode;
  /** Highlight as the primary action of the menu. */
  emphasis?: boolean;
};

/**
 * Context menu props
 */
export type TextContextMenuProps = {
  /** Whether the menu is visible */
  isOpen: boolean;
  /** Menu position */
  position: { x: number; y: number };
  /** Whether there's a selection (enables copy/cut) */
  hasSelection: boolean;
  /** Whether the editor is editable (enables paste/cut/delete) */
  isEditable: boolean;
  /** Whether clipboard has content (enables paste) */
  hasClipboardContent?: boolean;
  /** Callback when an action is selected */
  onAction: (action: TextContextAction) => void;
  /** Callback when menu is closed */
  onClose: () => void;
  /** Custom menu items (overrides default) */
  items?: TextContextMenuItem[];
  /** Additional className */
  className?: string;
};

/**
 * Hook options for text context menu
 */
export type UseTextContextMenuOptions = {
  /** Whether the context menu is enabled */
  enabled?: boolean;
  /** Whether the editor is editable */
  isEditable?: boolean;
  /** Container element ref */
  containerRef?: React.RefObject<HTMLElement>;
  /** Callback when an action is triggered */
  onAction?: (action: TextContextAction) => void;
};

/**
 * Hook return value
 */
export type UseTextContextMenuReturn = {
  /** Whether the menu is open */
  isOpen: boolean;
  /** Menu position */
  position: { x: number; y: number };
  /** Whether there's a text selection */
  hasSelection: boolean;
  /** Open the context menu */
  openMenu: (event: React.MouseEvent | MouseEvent) => void;
  /** Close the context menu */
  closeMenu: () => void;
  /** Handle action selection */
  handleAction: (action: TextContextAction) => void;
  /** Context menu event handler for onContextMenu prop */
  onContextMenu: (event: React.MouseEvent) => void;
};

// ============================================================================
// CONSTANTS
// ============================================================================

/**
 * Default menu items
 */
const DEFAULT_MENU_ITEMS: TextContextMenuItem[] = [
  { action: "cut", label: "Cut", shortcut: "Ctrl+X" },
  { action: "copy", label: "Copy", shortcut: "Ctrl+C" },
  { action: "paste", label: "Paste", shortcut: "Ctrl+V" },
  {
    action: "pasteAsPlainText",
    label: "Paste as Plain Text",
    shortcut: "Ctrl+Shift+V",
    dividerAfter: true,
  },
  { action: "delete", label: "Delete", shortcut: "Del", dividerAfter: true },
  { action: "acceptChange", label: "Accept Change" },
  { action: "rejectChange", label: "Reject Change", dividerAfter: true },
  { action: "selectAll", label: "Select All", shortcut: "Ctrl+A" },
];

// ============================================================================
// ICONS
// ============================================================================

/**
 * Get icon for action
 */
function getActionIcon(action: TextContextAction): React.ReactNode {
  if (!isBuiltInAction(action)) {
    return null;
  }
  const ICON_SIZE = 14;
  switch (action) {
    case "cut":
      return <ScissorsIcon size={ICON_SIZE} />;
    case "copy":
      return <CopyIcon size={ICON_SIZE} />;
    case "paste":
    case "pasteAsPlainText":
      return <ClipboardPasteIcon size={ICON_SIZE} />;
    case "delete":
      return <Trash2Icon size={ICON_SIZE} />;
    case "selectAll":
      return <TextSelectIcon size={ICON_SIZE} />;
    case "addRowAbove":
      return <ArrowUpToLineIcon size={ICON_SIZE} />;
    case "addRowBelow":
      return <ArrowDownToLineIcon size={ICON_SIZE} />;
    case "deleteRow":
      return <Trash2Icon size={ICON_SIZE} />;
    case "addColumnLeft":
      return <ArrowLeftToLineIcon size={ICON_SIZE} />;
    case "addColumnRight":
      return <ArrowRightToLineIcon size={ICON_SIZE} />;
    case "deleteColumn":
      return <Trash2Icon size={ICON_SIZE} />;
    case "tableBordersAll":
      return <Grid3x3Icon size={ICON_SIZE} />;
    case "tableBordersNone":
      return <SquareDashedIcon size={ICON_SIZE} />;
    case "addComment":
      return <MessageSquarePlusIcon size={ICON_SIZE} />;
    case "acceptChange":
    case "rejectChange":
    case "separator":
      // Tracked-change menu items use a different icon set rendered by
      // the surrounding menu component; this dispatcher leaves them
      // iconless.
      return null;
  }
}

const EMPHASIS_COLOR = "var(--primary, var(--doc-primary, #2563eb))";

function itemTextColor(item: TextContextMenuItem): string {
  if (item.disabled) {
    return "var(--muted-foreground, var(--doc-text-subtle, #737373))";
  }
  if (item.emphasis) {
    return EMPHASIS_COLOR;
  }
  return "var(--popover-foreground, var(--doc-text, #171717))";
}

function itemIconColor(item: TextContextMenuItem): string {
  if (item.disabled) {
    return "var(--border, var(--doc-border, #d4d4d4))";
  }
  if (item.emphasis) {
    return EMPHASIS_COLOR;
  }
  return "var(--muted-foreground, var(--doc-text-muted, #737373))";
}

// ============================================================================
// MENU ITEM COMPONENT
// ============================================================================

type MenuItemComponentProps = {
  item: TextContextMenuItem;
  onClick: () => void;
  isHighlighted: boolean;
  onMouseEnter: () => void;
};

const MenuItemComponent: React.FC<MenuItemComponentProps> = ({
  item,
  onClick,
  isHighlighted,
  onMouseEnter,
}) => {
  if (item.action === "separator") {
    return (
      <div
        className="docx-text-context-menu-separator"
        style={{
          height: "1px",
          backgroundColor: "var(--border, var(--doc-border, #e5e7eb))",
          margin: "4px 12px",
        }}
      />
    );
  }

  return (
    <>
      <button
        type="button"
        className={`docx-text-context-menu-item ${isHighlighted ? "docx-text-context-menu-item-highlighted" : ""} ${item.disabled ? "docx-text-context-menu-item-disabled" : ""}`}
        onClick={onClick}
        onMouseEnter={onMouseEnter}
        disabled={item.disabled}
        role="menuitem"
        aria-disabled={item.disabled}
        style={{
          display: "flex",
          alignItems: "center",
          gap: "10px",
          width: "100%",
          padding: "8px 12px",
          border: "none",
          background:
            isHighlighted && !item.disabled
              ? "var(--accent, var(--doc-primary-light, #f3f4f6))"
              : "transparent",
          cursor: item.disabled ? "not-allowed" : "pointer",
          fontSize: "13px",
          color: itemTextColor(item),
          fontWeight: item.emphasis ? 500 : 400,
          textAlign: "left",
          opacity: item.disabled ? 0.6 : 1,
        }}
      >
        <span
          style={{
            display: "flex",
            color: itemIconColor(item),
          }}
        >
          {item.icon ?? getActionIcon(item.action)}
        </span>
        <span style={{ flex: 1 }}>{item.label}</span>
        {item.shortcut && (
          <span
            style={{
              fontSize: "11px",
              color: "var(--muted-foreground, var(--doc-text-subtle, #737373))",
              fontFamily: "monospace",
            }}
          >
            {item.shortcut}
          </span>
        )}
      </button>
      {item.dividerAfter && (
        <div
          className="docx-text-context-menu-separator"
          style={{
            height: "1px",
            backgroundColor: "var(--border, var(--doc-border, #e5e7eb))",
            margin: "4px 12px",
          }}
        />
      )}
    </>
  );
};

// ============================================================================
// TEXT CONTEXT MENU COMPONENT
// ============================================================================

export const TextContextMenu: React.FC<TextContextMenuProps> = ({
  isOpen,
  position,
  hasSelection,
  isEditable,
  hasClipboardContent = true,
  onAction,
  onClose,
  items,
  className = "",
}) => {
  const menuRef = useRef<HTMLDivElement>(null);
  const [highlightedIndex, setHighlightedIndex] = useState(0);

  // Build menu items with disabled states
  const menuItems = (items ?? DEFAULT_MENU_ITEMS).map((item) => {
    const disabled = (() => {
      if (item.disabled !== undefined) {
        return item.disabled;
      }
      if (!isBuiltInAction(item.action)) {
        return false;
      }
      switch (item.action) {
        case "cut":
        case "copy":
        case "delete":
          return !hasSelection;
        case "paste":
        case "pasteAsPlainText":
          return !isEditable || !hasClipboardContent;
        case "acceptChange":
        case "rejectChange":
        case "selectAll":
        case "separator":
        case "addComment":
        case "addRowAbove":
        case "addRowBelow":
        case "deleteRow":
        case "addColumnLeft":
        case "addColumnRight":
        case "deleteColumn":
        case "tableBordersAll":
        case "tableBordersNone":
          // Caller controls these enable states via the explicit
          // `disabled` field on TextContextMenuItem — fall through to
          // enabled.
          return false;
      }
    })();

    const menuItem: TextContextMenuItem = {
      action: item.action,
      disabled,
      label: item.label,
    };
    if (item.shortcut !== undefined) {
      menuItem.shortcut = item.shortcut;
    }
    if (item.dividerAfter !== undefined) {
      menuItem.dividerAfter = item.dividerAfter;
    }
    return menuItem;
  });

  // Filter out separators for keyboard navigation
  const navigableItems = menuItems.filter(
    (item) => item.action !== "separator",
  );

  // Handle click outside
  useEffect(() => {
    if (!isOpen) {
      return;
    }

    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };

    // Use timeout to avoid immediately closing on right-click
    const timer = setTimeout(() => {
      document.addEventListener("mousedown", handleClickOutside);
    }, 0);

    return () => {
      clearTimeout(timer);
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, [isOpen, onClose]);

  // Handle keyboard navigation
  useEffect(() => {
    if (!isOpen) {
      return;
    }

    const handleKeyDown = (e: KeyboardEvent) => {
      switch (e.key) {
        case "Escape":
          e.preventDefault();
          onClose();
          break;
        case "ArrowDown":
          e.preventDefault();
          setHighlightedIndex((prev) => {
            let next = (prev + 1) % navigableItems.length;
            // Skip disabled items
            while (navigableItems[next]?.disabled && next !== prev) {
              next = (next + 1) % navigableItems.length;
            }
            return next;
          });
          break;
        case "ArrowUp":
          e.preventDefault();
          setHighlightedIndex((prev) => {
            let next =
              (prev - 1 + navigableItems.length) % navigableItems.length;
            // Skip disabled items
            while (navigableItems[next]?.disabled && next !== prev) {
              next = (next - 1 + navigableItems.length) % navigableItems.length;
            }
            return next;
          });
          break;
        case "Enter": {
          e.preventDefault();
          const item = navigableItems[highlightedIndex];
          if (item && !item.disabled) {
            onAction(item.action);
            onClose();
          }
          break;
        }
        default:
          break;
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, highlightedIndex, navigableItems, onAction, onClose]);

  // Reset highlighted index when menu opens
  useEffect(() => {
    if (isOpen) {
      setHighlightedIndex(0);
    }
  }, [isOpen]);

  // Position menu to stay within viewport. For text selections, prefer
  // opening above the clicked selection so the selected text remains visible.
  const getMenuStyle = useCallback((): React.CSSProperties => {
    const menuWidth = 220;
    const menuHeight = menuItems.length * 36 + 16;

    let x = position.x;
    let y =
      hasSelection && position.y - menuHeight - 8 >= 10
        ? position.y - menuHeight - 8
        : position.y;

    if (typeof window !== "undefined") {
      if (x + menuWidth > window.innerWidth) {
        x = window.innerWidth - menuWidth - 10;
      }
      if (y + menuHeight > window.innerHeight) {
        y = window.innerHeight - menuHeight - 10;
      }
      if (x < 10) {
        x = 10;
      }
      if (y < 10) {
        y = 10;
      }
    }

    return {
      backgroundColor: "var(--popover, var(--doc-bg, #ffffff))",
      border: "1px solid var(--border, var(--doc-border, #e5e7eb))",
      boxShadow:
        "0 12px 32px var(--doc-shadow-md, rgba(0,0,0,0.22)), 0 2px 8px var(--doc-shadow-sm, rgba(0,0,0,0.14))",
      color: "var(--popover-foreground, var(--doc-text, #171717))",
      fontFamily: "inherit",
      left: `${x}px`,
      minWidth: `${menuWidth}px`,
      top: `${y}px`,
      zIndex: 2_147_483_647,
    } satisfies React.CSSProperties;
  }, [hasSelection, position, menuItems.length]);

  const handleItemClick = (item: TextContextMenuItem) => {
    if (item.disabled) {
      return;
    }
    onAction(item.action);
    onClose();
  };

  if (!isOpen) {
    return null;
  }

  const menu = (
    <div
      ref={menuRef}
      className={`docx-text-context-menu fixed z-[2147483647] overflow-hidden rounded-lg border py-1 shadow-lg ${className}`}
      style={getMenuStyle()}
      role="menu"
      aria-label="Text editing menu"
    >
      {menuItems.map((item, index) => {
        // Find the index in navigable items for highlighting
        const navigableIndex = navigableItems.indexOf(item);

        return (
          <MenuItemComponent
            key={`${item.action}-${index}`}
            item={item}
            onClick={() => handleItemClick(item)}
            isHighlighted={navigableIndex === highlightedIndex}
            onMouseEnter={() => {
              if (navigableIndex !== -1 && !item.disabled) {
                setHighlightedIndex(navigableIndex);
              }
            }}
          />
        );
      })}
    </div>
  );

  if (typeof document === "undefined") {
    return menu;
  }

  return createPortal(menu, document.body);
};

// ============================================================================
// USE TEXT CONTEXT MENU HOOK
// ============================================================================

/**
 * Hook to manage text context menu state
 */
export function useTextContextMenu(
  options: UseTextContextMenuOptions = {},
): UseTextContextMenuReturn {
  const {
    enabled = true,
    isEditable: _isEditable = true,
    containerRef: _containerRef,
    onAction,
  } = options;

  const [isOpen, setIsOpen] = useState(false);
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const [hasSelection, setHasSelection] = useState(false);

  /**
   * Check if there's a text selection
   */
  const checkSelection = useCallback(() => {
    const selection = window.getSelection();
    const hasText =
      selection && !selection.isCollapsed && selection.toString().length > 0;
    setHasSelection(!!hasText);
    return !!hasText;
  }, []);

  /**
   * Open the context menu
   */
  const openMenu = useCallback(
    (event: React.MouseEvent | MouseEvent) => {
      if (!enabled) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();

      // Update selection state
      checkSelection();

      setPosition({ x: event.clientX, y: event.clientY });
      setIsOpen(true);
    },
    [enabled, checkSelection],
  );

  /**
   * Close the context menu
   */
  const closeMenu = useCallback(() => {
    setIsOpen(false);
  }, []);

  /**
   * Handle action selection
   */
  const handleAction = useCallback(
    (action: TextContextAction) => {
      closeMenu();

      // Execute the action
      switch (action) {
        case "cut":
          document.execCommand("cut");
          break;
        case "copy":
          document.execCommand("copy");
          break;
        case "paste":
          document.execCommand("paste");
          break;
        case "pasteAsPlainText":
          // Trigger paste event with shift key simulation
          // Note: This may not work in all browsers due to security restrictions
          navigator.clipboard
            .readText()
            .then((text) => {
              document.execCommand("insertText", false, text);
              return;
            })
            .catch(() => {
              // Fallback - just try regular paste
              document.execCommand("paste");
            });
          break;
        case "delete":
          document.execCommand("delete");
          break;
        case "selectAll":
          document.execCommand("selectAll");
          break;
        case "addRowAbove":
        case "addRowBelow":
        case "deleteRow":
        case "addColumnLeft":
        case "addColumnRight":
        case "deleteColumn":
        case "tableBordersAll":
        case "tableBordersNone":
        case "addComment":
        case "acceptChange":
        case "rejectChange":
        case "separator":
          // Non-clipboard actions are routed via the onAction callback
          // below — no execCommand needed here.
          break;
      }

      onAction?.(action);
    },
    [closeMenu, onAction],
  );

  /**
   * Context menu event handler
   */
  const onContextMenu = useCallback(
    (event: React.MouseEvent) => {
      openMenu(event);
    },
    [openMenu],
  );

  // Close menu when clicking elsewhere or pressing Escape
  useEffect(() => {
    if (!isOpen) {
      return;
    }

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        closeMenu();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, closeMenu]);

  return {
    isOpen,
    position,
    hasSelection,
    openMenu,
    closeMenu,
    handleAction,
    onContextMenu,
  };
}

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

/**
 * Get action label
 */
export function getTextActionLabel(action: TextContextAction): string {
  const labels = {
    cut: "Cut",
    copy: "Copy",
    paste: "Paste",
    pasteAsPlainText: "Paste as Plain Text",
    selectAll: "Select All",
    delete: "Delete",
    separator: "",
    addRowAbove: "Insert row above",
    addRowBelow: "Insert row below",
    deleteRow: "Delete row",
    addColumnLeft: "Insert column left",
    addColumnRight: "Insert column right",
    deleteColumn: "Delete column",
    tableBordersAll: "All borders",
    tableBordersNone: "No borders",
    addComment: "Comment",
    acceptChange: "Accept Change",
    rejectChange: "Reject Change",
  } as const satisfies Record<BuiltInTextContextAction, string>;
  return isBuiltInAction(action) ? labels[action] : "";
}

/**
 * Get action shortcut
 */
export function getTextActionShortcut(action: TextContextAction): string {
  const shortcuts = {
    cut: "Ctrl+X",
    copy: "Ctrl+C",
    paste: "Ctrl+V",
    pasteAsPlainText: "Ctrl+Shift+V",
    selectAll: "Ctrl+A",
    delete: "Del",
    separator: "",
    addRowAbove: "",
    addRowBelow: "",
    deleteRow: "",
    addColumnLeft: "",
    addColumnRight: "",
    deleteColumn: "",
    tableBordersAll: "",
    tableBordersNone: "",
    addComment: "",
    acceptChange: "",
    rejectChange: "",
  } as const satisfies Record<BuiltInTextContextAction, string>;
  return isBuiltInAction(action) ? shortcuts[action] : "";
}

/**
 * Get default menu items
 */
export function getDefaultTextContextMenuItems(): TextContextMenuItem[] {
  return [...DEFAULT_MENU_ITEMS];
}

/**
 * Check if action is available
 */
export function isTextActionAvailable(
  action: TextContextAction,
  hasSelection: boolean,
  isEditable: boolean,
): boolean {
  if (!isBuiltInAction(action)) {
    return true;
  }
  switch (action) {
    case "cut":
    case "copy":
    case "delete":
      return hasSelection;
    case "paste":
    case "pasteAsPlainText":
      return isEditable;
    case "addComment":
      return hasSelection;
    case "acceptChange":
    case "rejectChange":
      return true; // Visibility controlled by context menu builder
    case "selectAll":
      return true;
    case "addRowAbove":
    case "addRowBelow":
    case "deleteRow":
    case "addColumnLeft":
    case "addColumnRight":
    case "deleteColumn":
    case "tableBordersAll":
    case "tableBordersNone":
    case "separator":
      // Availability of table-edit actions is determined by the menu
      // builder based on whether the cursor is inside a table cell.
      return true;
  }
}

// ============================================================================
// EXPORTS
// ============================================================================
