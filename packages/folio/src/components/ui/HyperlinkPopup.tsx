/**
 * HyperlinkPopup — floating popup for viewing/editing hyperlinks.
 * View mode: URL + copy/edit/unlink buttons.
 * Edit mode: text + URL inputs with Apply.
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

import {
  ClipboardCopyIcon,
  GlobeIcon,
  LinkIcon,
  PencilIcon,
  TypeIcon,
  UnlinkIcon,
} from "lucide-react";
import { useTranslations } from "use-intl";

import { containedHandler } from "@stll/ui/hooks/use-contained-handler";

export type HyperlinkPopupData = {
  href: string;
  displayText: string;
  tooltip?: string;
  /**
   * Live reference to the anchor element. The popup recomputes its position
   * from this element's bounding rect on every scroll/resize so it stays
   * pinned to the link as the page scrolls (eigenpal #514). Required because
   * the popup is `position: fixed` to the viewport — without a live
   * reference, the popup stays at the original screen position while the
   * link moves out from under it.
   */
  anchorEl: HTMLAnchorElement;
};

export type HyperlinkPopupProps = {
  data: HyperlinkPopupData | null;
  onNavigate: (href: string) => void;
  onCopy: (href: string) => void;
  onEdit: (displayText: string, href: string) => void;
  onRemove: () => void;
  onClose: () => void;
  readOnly?: boolean;
};

export function HyperlinkPopup({
  data,
  onNavigate,
  onCopy,
  onEdit,
  onRemove,
  onClose,
  readOnly,
}: HyperlinkPopupProps) {
  const t = useTranslations("folio");
  const [mode, setMode] = useState<"view" | "edit">("view");
  const [editText, setEditText] = useState("");
  const [editUrl, setEditUrl] = useState("");
  const popupRef = useRef<HTMLDivElement>(null);
  const textInputRef = useRef<HTMLInputElement>(null);
  const [anchorPosition, setAnchorPosition] = useState<{
    top: number;
    left: number;
  } | null>(null);

  useEffect(() => {
    if (data) {
      setMode("view");
      setEditText(data.displayText);
      setEditUrl(data.href);
    }
  }, [data]);

  // Recompute popup position from the live anchor element on every scroll /
  // resize / layout change. `position: fixed` snapshots the click-time rect,
  // so without this the popup stays at the original viewport position while
  // the link scrolls away beneath it.
  //
  // `useLayoutEffect` runs the initial read BEFORE the browser paints so the
  // popup never appears at the default (0,0) for a frame — without this we
  // saw a single-frame flicker when the popup mounted.
  //
  // The scroll/resize callback is rAF-throttled so high-frequency listeners
  // (touch-scroll, smooth-scroll, ResizeObserver bursts) coalesce to one
  // update per frame. Connected-check guards against the anchor being
  // detached mid-scroll (document edits, page unmount) — without it,
  // `getBoundingClientRect()` returns all-zeros and the popup snaps to the
  // viewport top-left.
  useLayoutEffect(() => {
    if (!data) {
      setAnchorPosition(null);
      return;
    }
    const anchor = data.anchorEl;
    let rafId: number | null = null;
    const read = () => {
      rafId = null;
      if (!anchor.isConnected) {
        return;
      }
      const rect = anchor.getBoundingClientRect();
      setAnchorPosition({ top: rect.bottom + 4, left: rect.left });
    };
    const update = () => {
      if (rafId !== null) {
        return;
      }
      rafId = requestAnimationFrame(read);
    };
    read();
    window.addEventListener("scroll", update, true);
    window.addEventListener("resize", update);
    return () => {
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
      }
      window.removeEventListener("scroll", update, true);
      window.removeEventListener("resize", update);
    };
  }, [data]);

  useEffect(() => {
    if (mode === "edit") {
      requestAnimationFrame(() => {
        textInputRef.current?.focus();
        textInputRef.current?.select();
      });
    }
  }, [mode]);

  // Close on outside click
  useEffect(() => {
    if (!data) {
      return;
    }
    const handle = (e: MouseEvent) => {
      if (popupRef.current && !popupRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    const timer = setTimeout(
      () => document.addEventListener("mousedown", handle),
      0,
    );
    return () => {
      clearTimeout(timer);
      document.removeEventListener("mousedown", handle);
    };
  }, [data, onClose]);

  // Close on Escape
  useEffect(() => {
    if (!data) {
      return;
    }
    const handle = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (mode === "edit") {
          setMode("view");
        } else {
          onClose();
        }
      }
    };
    document.addEventListener("keydown", handle);
    return () => document.removeEventListener("keydown", handle);
  }, [data, mode, onClose]);

  const handleApply = useCallback(() => {
    const url = editUrl.trim();
    if (!url) {
      return;
    }
    onEdit(editText.trim() || url, url);
  }, [editText, editUrl, onEdit]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter") {
        e.preventDefault();
        handleApply();
      }
    },
    [handleApply],
  );

  if (!data) {
    return null;
  }

  // Render off-screen until the first scroll/resize listener fires; this
  // happens synchronously after the initial useEffect so it's a single frame.
  if (!anchorPosition) {
    return null;
  }
  const top = anchorPosition.top;
  const left = anchorPosition.left;

  const iconBtn =
    "flex size-7 items-center justify-center rounded text-[var(--doc-text-muted)] hover:bg-[var(--doc-bg-hover)] transition-colors";
  const inputCls =
    "border-input bg-background text-foreground flex-1 rounded border px-2 py-1 text-sm outline-none focus:border-[var(--doc-primary)]";

  if (mode === "edit") {
    return (
      <div
        ref={popupRef}
        className="fixed z-[10000] w-80 rounded-lg border border-[var(--doc-border)] bg-[var(--doc-page)] p-3 shadow-lg"
        onMouseDown={containedHandler(popupRef, (e) => e.stopPropagation())}
        role="presentation"
        style={{ top, left }}
      >
        <div className="mb-2 flex items-center gap-2">
          <TypeIcon className="text-muted-foreground size-4.5 shrink-0" />
          <input
            ref={textInputRef}
            className={inputCls}
            onChange={(e) => setEditText(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={t("displayText")}
            type="text"
            value={editText}
          />
        </div>
        <div className="flex items-center gap-2">
          <LinkIcon className="text-muted-foreground size-4.5 shrink-0" />
          <input
            className={inputCls}
            onChange={(e) => setEditUrl(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="https://example.com"
            type="text"
            value={editUrl}
          />
          <button
            className="text-primary shrink-0 rounded px-3 py-1 text-sm font-semibold disabled:opacity-40"
            disabled={!editUrl.trim()}
            onClick={handleApply}
            type="button"
          >
            Apply
          </button>
        </div>
      </div>
    );
  }

  return (
    <div
      ref={popupRef}
      className="fixed z-[10000] flex max-w-[400px] items-center gap-2 rounded-lg border border-[var(--doc-border)] bg-[var(--doc-page)] px-3 py-2 shadow-lg"
      onMouseDown={containedHandler(popupRef, (e) => e.stopPropagation())}
      role="presentation"
      style={{ top, left }}
    >
      <GlobeIcon className="text-muted-foreground size-4.5 shrink-0" />
      <a
        className="text-primary truncate text-sm hover:underline"
        href={data.href}
        onClick={(e) => {
          e.preventDefault();
          onNavigate(data.href);
        }}
        rel="noopener noreferrer"
        target="_blank"
        title={data.href}
      >
        {data.href}
      </a>
      <span className="bg-border h-5 w-px shrink-0" />
      <button
        className={iconBtn}
        onClick={() => onCopy(data.href)}
        title={t("copyLink")}
        type="button"
      >
        <ClipboardCopyIcon size={16} />
      </button>
      {!readOnly && (
        <>
          <button
            className={iconBtn}
            onClick={() => {
              setEditText(data.displayText);
              setEditUrl(data.href);
              setMode("edit");
            }}
            title={t("editLink")}
            type="button"
          >
            <PencilIcon size={16} />
          </button>
          <button
            className={iconBtn}
            onClick={onRemove}
            title={t("removeLink")}
            type="button"
          >
            <UnlinkIcon size={16} />
          </button>
        </>
      )}
    </div>
  );
}
