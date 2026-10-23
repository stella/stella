import { createIsomorphicFn } from "@tanstack/react-start";
import { getCookie } from "@tanstack/react-start/server";

import { Temporal } from "@stll/time";

import { detached } from "@/lib/detached";

/**
 * The sidebar's open state outlives a reload. It is a cookie, not browser
 * storage, so the server render of every document already draws the sidebar
 * the way the user left it instead of expanding it and snapping shut once the
 * browser reads its storage.
 *
 * The server reads the cookie (this module is the one owner of that read) and
 * writes the value on `<html>`; the browser reads it back from there, so the
 * server render and hydration always agree. A toggle updates both.
 */
const SIDEBAR_STATE_COOKIE = "sidebar_state";
export const SIDEBAR_STATE_ATTRIBUTE = "data-sidebar-state";

/** Until the user first toggles it, the sidebar is open. */
export const DEFAULT_SIDEBAR_OPEN = true;

const SIDEBAR_STATE_LIFETIME_HOURS = 24 * 365;

/** `null` when the user never chose: callers fall back to their default. */
export const parsePersistedSidebarOpen = (
  storedState: string | null | undefined,
): boolean | null => {
  switch (storedState) {
    case "expanded":
      return true;
    case "collapsed":
      return false;
    default:
      return null;
  }
};

const sidebarStateValue = (open: boolean) => (open ? "expanded" : "collapsed");

/** The stored state, as the document's root element carries it. */
export const readSidebarStateAttribute = createIsomorphicFn()
  .server((): string | undefined => {
    const stored = parsePersistedSidebarOpen(getCookie(SIDEBAR_STATE_COOKIE));
    return stored === null ? undefined : sidebarStateValue(stored);
  })
  .client(
    (): string | undefined =>
      document.documentElement.getAttribute(SIDEBAR_STATE_ATTRIBUTE) ??
      undefined,
  );

export const readPersistedSidebarOpen = (): boolean | null =>
  parsePersistedSidebarOpen(readSidebarStateAttribute());

export const writePersistedSidebarOpen = (open: boolean) => {
  const value = sidebarStateValue(open);
  document.documentElement.setAttribute(SIDEBAR_STATE_ATTRIBUTE, value);
  // Without the Cookie Store API the choice holds until the next reload.
  if (!("cookieStore" in globalThis)) {
    return;
  }
  detached(
    globalThis.cookieStore.set({
      name: SIDEBAR_STATE_COOKIE,
      value,
      path: "/",
      sameSite: "lax",
      expires: Temporal.Now.instant().add({
        hours: SIDEBAR_STATE_LIFETIME_HOURS,
      }).epochMilliseconds,
    }),
    "sidebar-state.persist",
  );
};
