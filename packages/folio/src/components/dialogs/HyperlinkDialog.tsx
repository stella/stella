/**
 * Hyperlink Dialog Component
 *
 * Modal dialog for inserting and editing hyperlinks in the document.
 * Supports both external URLs and internal bookmark links.
 *
 * Features:
 * - Input for URL (http, https, mailto, tel, etc.)
 * - Input for display text
 * - Edit existing hyperlinks
 * - Remove hyperlink option
 * - Internal bookmark selection
 * - Validation and error handling
 */

import { useEffect, useRef, useState } from "react";
import type { FormEvent, KeyboardEvent } from "react";

import {
  Dialog,
  DialogPortal,
  DialogBackdrop,
  DialogPopup,
  DialogTitle,
  DialogClose,
} from "@stella/ui/components/dialog";

// ============================================================================
// TYPES
// ============================================================================

/**
 * Hyperlink data structure for dialog
 */
export type HyperlinkData = {
  /** URL for external link */
  url?: string;
  /** Display text for the link */
  displayText?: string;
  /** Internal bookmark name */
  bookmark?: string;
  /** Tooltip text */
  tooltip?: string;
};

/**
 * Bookmark option for internal link selection
 */
export type BookmarkOption = {
  /** Bookmark name/ID */
  name: string;
  /** Optional display label */
  label?: string;
};

/**
 * Props for the HyperlinkDialog component
 */
export type HyperlinkDialogProps = {
  /** Whether the dialog is open */
  isOpen: boolean;
  /** Callback when dialog is closed */
  onClose: () => void;
  /** Callback when hyperlink is inserted/updated */
  onSubmit: (data: HyperlinkData) => void;
  /** Callback when hyperlink is removed */
  onRemove?: () => void;
  /** Initial data for editing existing hyperlink */
  initialData?: HyperlinkData;
  /** Currently selected text (used as default display text) */
  selectedText?: string;
  /** Whether we're editing an existing hyperlink */
  isEditing?: boolean;
  /** Available bookmarks for internal links */
  bookmarks?: BookmarkOption[];
};

// ============================================================================
// URL VALIDATION
// ============================================================================

/**
 * Validate a URL string
 * Supports http, https, mailto, tel, ftp protocols
 */
export function isValidUrl(url: string): boolean {
  if (!url || url.trim() === "") {
    return false;
  }

  const trimmed = url.trim();

  // Allow mailto: and tel: links
  if (trimmed.startsWith("mailto:") || trimmed.startsWith("tel:")) {
    return trimmed.length > 7; // Has content after protocol
  }

  // Allow ftp: links
  if (trimmed.startsWith("ftp://")) {
    return trimmed.length > 6;
  }

  // HTTP/HTTPS URLs
  try {
    // Add protocol if missing for validation
    const urlToValidate = /^https?:\/\//.test(trimmed)
      ? trimmed
      : `https://${trimmed}`;
    const parsed = new URL(urlToValidate);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Normalize a URL by adding protocol if needed
 */
export function normalizeUrl(url: string): string {
  if (!url) {
    return "";
  }

  const trimmed = url.trim();

  // Keep special protocols as-is
  if (
    trimmed.startsWith("mailto:") ||
    trimmed.startsWith("tel:") ||
    trimmed.startsWith("ftp://")
  ) {
    return trimmed;
  }

  // Add https:// if no protocol specified
  if (!/^https?:\/\//.test(trimmed)) {
    return `https://${trimmed}`;
  }

  return trimmed;
}

/**
 * Detect URL type from string
 */
export function getUrlType(
  url: string,
): "web" | "email" | "phone" | "ftp" | "unknown" {
  if (!url) {
    return "unknown";
  }

  const trimmed = url.trim().toLowerCase();

  if (trimmed.startsWith("mailto:")) {
    return "email";
  }
  if (trimmed.startsWith("tel:")) {
    return "phone";
  }
  if (trimmed.startsWith("ftp://")) {
    return "ftp";
  }
  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
    return "web";
  }
  if (trimmed.includes("@") && !trimmed.includes(" ")) {
    return "email";
  }

  return "web"; // Default to web
}

// ============================================================================
// MAIN COMPONENT
// ============================================================================

type LinkType = "url" | "bookmark";

/**
 * HyperlinkDialog component - Modal for inserting/editing hyperlinks
 */
export function HyperlinkDialog({
  isOpen,
  onClose,
  onSubmit,
  onRemove,
  initialData,
  selectedText = "",
  isEditing = false,
  bookmarks = [],
}: HyperlinkDialogProps) {
  // State
  const [linkType, setLinkType] = useState<LinkType>("url");
  const [url, setUrl] = useState("");
  const [displayText, setDisplayText] = useState("");
  const [bookmark, setBookmark] = useState("");
  const [tooltip, setTooltip] = useState("");
  const [urlError, setUrlError] = useState("");
  const [touched, setTouched] = useState(false);

  // Refs
  const urlInputRef = useRef<HTMLInputElement>(null);
  const bookmarkSelectRef = useRef<HTMLSelectElement>(null);

  // Initialize form with initial data or selected text
  useEffect(() => {
    if (isOpen) {
      if (initialData) {
        // Editing existing hyperlink
        if (initialData.bookmark) {
          setLinkType("bookmark");
          setBookmark(initialData.bookmark);
        } else {
          setLinkType("url");
          setUrl(initialData.url || "");
        }
        setDisplayText(initialData.displayText || "");
        setTooltip(initialData.tooltip || "");
      } else {
        // New hyperlink
        setLinkType("url");
        setUrl("");
        setDisplayText(selectedText);
        setBookmark("");
        setTooltip("");
      }
      setUrlError("");
      setTouched(false);
    }
  }, [isOpen, initialData, selectedText]);

  // Focus input when dialog opens
  useEffect(() => {
    if (isOpen) {
      setTimeout(() => {
        if (linkType === "url") {
          urlInputRef.current?.focus();
        } else {
          bookmarkSelectRef.current?.focus();
        }
      }, 100);
    }
  }, [isOpen, linkType]);

  /**
   * Validate URL on blur
   */
  const validateUrl = () => {
    if (linkType === "url" && url.trim()) {
      if (!isValidUrl(url)) {
        setUrlError("Please enter a valid URL");
      } else {
        setUrlError("");
      }
    } else {
      setUrlError("");
    }
  };

  /**
   * Handle form submission
   */
  const handleSubmit = (e?: FormEvent) => {
    e?.preventDefault();

    // Validate
    if (linkType === "url") {
      if (!url.trim()) {
        setUrlError("URL is required");
        setTouched(true);
        return;
      }
      if (!isValidUrl(url)) {
        setUrlError("Please enter a valid URL");
        setTouched(true);
        return;
      }
    } else if (linkType === "bookmark" && !bookmark) {
      return; // No bookmark selected
    }

    // Build hyperlink data
    const trimmedDisplay = displayText.trim();
    const trimmedTooltip = tooltip.trim();
    const data: HyperlinkData = {
      ...(trimmedDisplay ? { displayText: trimmedDisplay } : {}),
      ...(trimmedTooltip ? { tooltip: trimmedTooltip } : {}),
    };

    if (linkType === "url") {
      data.url = normalizeUrl(url);
    } else {
      data.bookmark = bookmark;
    }

    onSubmit(data);
  };

  /**
   * Handle keyboard events
   */
  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      // Submit on Enter (except in textarea)
      const target = e.target as HTMLElement;
      if (target.tagName !== "TEXTAREA") {
        e.preventDefault();
        handleSubmit();
      }
    }
  };

  const hasBookmarks = bookmarks.length > 0;
  const canSubmit =
    (linkType === "url" && url.trim() && !urlError) ||
    (linkType === "bookmark" && bookmark);

  const labelCls = "text-foreground mb-1.5 block text-sm font-medium";
  const inputCls =
    "border-input bg-background text-foreground w-full rounded border px-3 py-2.5 text-sm outline-none";
  const inputErrorCls =
    "border-destructive bg-background text-foreground w-full rounded border px-3 py-2.5 text-sm outline-none";
  const hintCls = "text-muted-foreground mt-1 text-xs";

  return (
    <Dialog open={isOpen} onOpenChange={(o) => !o && onClose()}>
      <DialogPortal>
        <DialogBackdrop className="fixed inset-0 z-[10000] bg-black/50" />
        <DialogPopup
          className="bg-popover fixed start-1/2 top-1/2 z-[10001] w-full max-w-[500px] min-w-[400px] -translate-x-1/2 -translate-y-1/2 rounded-lg border shadow-xl"
          onKeyDown={handleKeyDown}
        >
          {/* Header */}
          <div className="flex items-center justify-between border-b px-5 py-4">
            <DialogTitle className="text-lg font-semibold">
              {isEditing ? "Edit Hyperlink" : "Insert Hyperlink"}
            </DialogTitle>
            <DialogClose
              className="text-muted-foreground cursor-pointer border-none bg-none px-2 py-1 text-xl leading-none"
              aria-label="Close dialog"
            >
              &times;
            </DialogClose>
          </div>

          {/* Body */}
          <form className="px-5 py-5" onSubmit={handleSubmit}>
            {/* Link type tabs */}
            {hasBookmarks && (
              <div className="mb-4 flex border-b">
                <button
                  type="button"
                  className={`-mb-px cursor-pointer border-b-2 border-none bg-none px-4 py-2.5 text-sm ${
                    linkType === "url"
                      ? "text-primary border-b-primary font-medium"
                      : "text-muted-foreground border-b-transparent"
                  }`}
                  onClick={() => setLinkType("url")}
                >
                  Web Address
                </button>
                <button
                  type="button"
                  className={`-mb-px cursor-pointer border-b-2 border-none bg-none px-4 py-2.5 text-sm ${
                    linkType === "bookmark"
                      ? "text-primary border-b-primary font-medium"
                      : "text-muted-foreground border-b-transparent"
                  }`}
                  onClick={() => setLinkType("bookmark")}
                >
                  Bookmark
                </button>
              </div>
            )}

            {/* URL input */}
            {linkType === "url" && (
              <div className="mb-4">
                <label htmlFor="hyperlink-url" className={labelCls}>
                  URL
                </label>
                <input
                  ref={urlInputRef}
                  id="hyperlink-url"
                  type="text"
                  className={urlError && touched ? inputErrorCls : inputCls}
                  value={url}
                  onChange={(e) => {
                    setUrl(e.target.value);
                    if (touched) {
                      setUrlError("");
                    }
                  }}
                  onBlur={() => {
                    setTouched(true);
                    validateUrl();
                  }}
                  placeholder="https://example.com"
                  aria-invalid={!!urlError}
                  aria-describedby={urlError ? "url-error" : "url-hint"}
                />
                {urlError && touched && (
                  <div id="url-error" className="text-destructive mt-1 text-xs">
                    {urlError}
                  </div>
                )}
                {!urlError && (
                  <div id="url-hint" className={hintCls}>
                    Enter a web address, email (mailto:), or phone (tel:)
                  </div>
                )}
              </div>
            )}

            {/* Bookmark select */}
            {linkType === "bookmark" && (
              <div className="mb-4">
                <label htmlFor="hyperlink-bookmark" className={labelCls}>
                  Bookmark
                </label>
                <select
                  ref={bookmarkSelectRef}
                  id="hyperlink-bookmark"
                  className={`${inputCls} cursor-pointer`}
                  value={bookmark}
                  onChange={(e) => setBookmark(e.target.value)}
                >
                  <option value="">Select a bookmark...</option>
                  {bookmarks.map((bm) => (
                    <option key={bm.name} value={bm.name}>
                      {bm.label || bm.name}
                    </option>
                  ))}
                </select>
              </div>
            )}

            {/* Display text */}
            <div className="mb-4">
              <label htmlFor="hyperlink-display-text" className={labelCls}>
                Display Text
              </label>
              <input
                id="hyperlink-display-text"
                type="text"
                className={inputCls}
                value={displayText}
                onChange={(e) => setDisplayText(e.target.value)}
                placeholder="Text to display (optional)"
              />
              <div className={hintCls}>
                Leave empty to use the selected text
              </div>
            </div>

            {/* Tooltip */}
            <div className="mb-4">
              <label htmlFor="hyperlink-tooltip" className={labelCls}>
                Tooltip (optional)
              </label>
              <input
                id="hyperlink-tooltip"
                type="text"
                className={inputCls}
                value={tooltip}
                onChange={(e) => setTooltip(e.target.value)}
                placeholder="Text shown on hover"
              />
            </div>
          </form>

          {/* Footer */}
          <div className="flex justify-end gap-3 border-t px-5 py-4">
            {isEditing && onRemove && (
              <button
                type="button"
                className="bg-destructive text-destructive-foreground rounded px-5 py-2.5 text-sm font-medium"
                onClick={onRemove}
              >
                Remove Link
              </button>
            )}
            <div className="flex-1" />
            <DialogClose className="border-input rounded border px-5 py-2.5 text-sm font-medium">
              Cancel
            </DialogClose>
            <button
              type="submit"
              className={
                canSubmit
                  ? "bg-primary text-primary-foreground rounded px-5 py-2.5 text-sm font-medium"
                  : "bg-muted text-muted-foreground cursor-not-allowed rounded px-5 py-2.5 text-sm font-medium"
              }
              onClick={handleSubmit}
              disabled={!canSubmit}
            >
              {isEditing ? "Update" : "Insert"}
            </button>
          </div>
        </DialogPopup>
      </DialogPortal>
    </Dialog>
  );
}

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

/**
 * Create HyperlinkData from a URL string
 */
export function createHyperlinkData(
  url: string,
  displayText?: string,
): HyperlinkData {
  return {
    url: normalizeUrl(url),
    ...(displayText !== undefined ? { displayText } : {}),
  };
}

/**
 * Create HyperlinkData for an internal bookmark
 */
export function createBookmarkLinkData(
  bookmark: string,
  displayText?: string,
): HyperlinkData {
  return {
    bookmark,
    ...(displayText !== undefined ? { displayText } : {}),
  };
}

/**
 * Check if HyperlinkData is for an external URL
 */
export function isExternalHyperlinkData(data: HyperlinkData): boolean {
  return !!data.url && !data.bookmark;
}

/**
 * Check if HyperlinkData is for an internal bookmark
 */
export function isBookmarkHyperlinkData(data: HyperlinkData): boolean {
  return !!data.bookmark;
}

/**
 * Get display text from HyperlinkData, falling back to URL/bookmark
 */
export function getDisplayText(data: HyperlinkData): string {
  if (data.displayText) {
    return data.displayText;
  }
  if (data.url) {
    // Strip protocol for display
    return data.url.replace(/^https?:\/\//, "");
  }
  if (data.bookmark) {
    return data.bookmark;
  }
  return "";
}

/**
 * Convert email address to mailto: link
 */
export function emailToMailto(email: string): string {
  if (email.startsWith("mailto:")) {
    return email;
  }
  return `mailto:${email}`;
}

/**
 * Convert phone number to tel: link
 */
export function phoneToTel(phone: string): string {
  if (phone.startsWith("tel:")) {
    return phone;
  }
  // Remove common formatting characters
  const cleaned = phone.replace(/[\s\-().]/g, "");
  return `tel:${cleaned}`;
}

/**
 * Extract bookmarks from document for the dialog
 */
export function extractBookmarksForDialog(
  bookmarks: { name: string; id: number }[],
): BookmarkOption[] {
  return bookmarks
    .filter((bm) => !bm.name.startsWith("_")) // Filter out internal bookmarks
    .map((bm) => ({
      name: bm.name,
      label: bm.name,
    }))
    .toSorted((a, b) => a.name.localeCompare(b.name));
}

// ============================================================================
// HOOK
// ============================================================================

/**
 * Hook state for the Hyperlink dialog
 */
export type UseHyperlinkDialogState = {
  /** Whether the dialog is open */
  isOpen: boolean;
  /** Initial data for the dialog (for editing) */
  initialData?: HyperlinkData;
  /** Currently selected text */
  selectedText?: string;
  /** Whether we're editing an existing hyperlink */
  isEditing: boolean;
};

/**
 * Hook return type for the Hyperlink dialog
 */
export type UseHyperlinkDialogReturn = {
  /** Current state */
  state: UseHyperlinkDialogState;
  /** Open dialog for inserting new hyperlink */
  openInsert: (selectedText?: string) => void;
  /** Open dialog for editing existing hyperlink */
  openEdit: (data: HyperlinkData) => void;
  /** Close the dialog */
  close: () => void;
  /** Toggle dialog open/closed */
  toggle: () => void;
};

/**
 * Hook for managing Hyperlink dialog state
 */
export function useHyperlinkDialog(): UseHyperlinkDialogReturn {
  const [state, setState] = useState<UseHyperlinkDialogState>({
    isOpen: false,
    isEditing: false,
  });

  const openInsert = (selectedText?: string) => {
    setState({
      isOpen: true,
      ...(selectedText !== undefined ? { selectedText } : {}),
      isEditing: false,
    });
  };

  const openEdit = (data: HyperlinkData) => {
    setState({
      isOpen: true,
      initialData: data,
      ...(data.displayText !== undefined
        ? { selectedText: data.displayText }
        : {}),
      isEditing: true,
    });
  };

  const close = () => {
    setState((prev) => ({
      ...prev,
      isOpen: false,
    }));
  };

  const toggle = () => {
    setState((prev) => ({
      ...prev,
      isOpen: !prev.isOpen,
    }));
  };

  return { state, openInsert, openEdit, close, toggle };
}

export default HyperlinkDialog;
