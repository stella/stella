/**
 * The extension's content script announces itself once, when it loads, and
 * relays only pings of its own protocol version. On another version that
 * announcement is the only sign it is installed, and it usually arrives
 * before the chat bridge mounts. The client entry starts this listener, so
 * the bridge can replay the announcement it would otherwise miss.
 *
 * Kept free of imports: it runs in the entry chunk, before the runtime loads.
 */

const EXTENSION_SOURCE = "stella-browser-extension";
const ANNOUNCEMENT_REQUEST_ID = "extension-ready";

let latestAnnouncement: unknown = null;
let listening = false;

const isAnnouncement = (data: unknown): boolean =>
  typeof data === "object" &&
  data !== null &&
  "source" in data &&
  data.source === EXTENSION_SOURCE &&
  "requestId" in data &&
  data.requestId === ANNOUNCEMENT_REQUEST_ID;

const recordAnnouncement = ({ data, origin, source }: MessageEvent): void => {
  if (
    source === window &&
    origin === window.location.origin &&
    isAnnouncement(data)
  ) {
    latestAnnouncement = data;
  }
};

/** Starts listening once per page; the returned stop also forgets. */
export const listenForBrowserExtensionAnnouncement = (): (() => void) => {
  if (listening || typeof window === "undefined") {
    return () => undefined;
  }
  listening = true;
  const target = window;
  target.addEventListener("message", recordAnnouncement);
  return () => {
    target.removeEventListener("message", recordAnnouncement);
    listening = false;
    latestAnnouncement = null;
  };
};

/** The extension's last load announcement on this page, unvalidated. */
export const latestBrowserExtensionAnnouncement = (): unknown =>
  latestAnnouncement;
