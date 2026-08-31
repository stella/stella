import { useExternalSyncEffect } from "@/hooks/use-effect";

const FAVICON_LINK_ID = "stella-unread-favicon";

/**
 * The unread tab icon: the app's ground with a dot on it.
 *
 * Deliberately not a redraw of the brand mark. At tab size the mark is a few
 * pixels wide and unreadable anyway, so copying its paths here would buy
 * nothing and would quietly drift from `public/favicon.svg` the first time
 * that file changes. Only the ground colour is shared, and it is named here
 * so the mirror is one obvious literal rather than a hidden dependency.
 *
 * Inline in a data URI so the badge appears without a network round trip.
 */
const FAVICON_GROUND = "#59a1d4";
const UNREAD_FAVICON_HREF = `data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 56 56">' +
    `<rect width="56" height="56" rx="12" fill="${FAVICON_GROUND}"/>` +
    `<circle cx="41" cy="15" r="12" fill="#ef4444" stroke="${FAVICON_GROUND}" stroke-width="4"/>` +
    "</svg>",
)}`;

/**
 * Mark the browser tab while the reader has unread notifications.
 *
 * A genuine external-system sync: the tab icon lives in `document.head`, not
 * in the React tree, and it has to follow a value that changes. The original
 * icon link is left in place and a second, higher-priority link is added and
 * removed, so nothing has to remember and restore the app's own favicon URL.
 */
export const useUnreadFaviconDot = (hasUnread: boolean): void => {
  useExternalSyncEffect(() => {
    if (!hasUnread) {
      return undefined;
    }

    const link = document.createElement("link");
    link.id = FAVICON_LINK_ID;
    link.rel = "icon";
    link.type = "image/svg+xml";
    link.href = UNREAD_FAVICON_HREF;
    // Appended last so it wins over the static icon links in the document head
    // without mutating (and having to restore) them.
    document.head.append(link);

    return () => {
      link.remove();
    };
  }, [hasUnread]);
};
