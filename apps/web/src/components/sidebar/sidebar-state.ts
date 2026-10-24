import { createIsomorphicFn, createServerFn } from "@tanstack/react-start";
import { getCookie, setCookie } from "@tanstack/react-start/server";
import * as v from "valibot";

import { Temporal } from "@stll/time";

import {
  SIDEBAR_STATE_COOKIE,
  SIDEBAR_STATE_VALUES,
} from "@/components/sidebar/sidebar-state-cookie";
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
export const SIDEBAR_STATE_ATTRIBUTE = "data-sidebar-state";

/** Until the user first toggles it, the sidebar is open. */
export const DEFAULT_SIDEBAR_OPEN = true;

const SIDEBAR_STATE_LIFETIME_HOURS = 24 * 365;

/** `null` when the user never chose: callers fall back to their default. */
export const parsePersistedSidebarOpen = (
  storedState: string | null | undefined,
): boolean | null => {
  if (storedState === null || storedState === undefined) {
    return null;
  }
  switch (storedState) {
    case SIDEBAR_STATE_VALUES.expanded:
      return true;
    case SIDEBAR_STATE_VALUES.collapsed:
      return false;
    default:
      return null;
  }
};

const sidebarStateValue = (open: boolean) =>
  open ? SIDEBAR_STATE_VALUES.expanded : SIDEBAR_STATE_VALUES.collapsed;

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

const persistSidebarState = createServerFn({ method: "POST" })
  .validator((input: boolean) => v.parse(v.boolean(), input))
  .handler(({ data }) => {
    setCookie(SIDEBAR_STATE_COOKIE, sidebarStateValue(data), {
      path: "/",
      sameSite: "lax",
      maxAge: SIDEBAR_STATE_LIFETIME_HOURS * 60 * 60,
    });
  });

type PersistSidebarState = (input: { data: boolean }) => Promise<unknown>;

let sidebarPersistence = Promise.resolve();

export const writePersistedSidebarOpen = (
  open: boolean,
  persist: PersistSidebarState = persistSidebarState,
) => {
  const value = sidebarStateValue(open);
  document.documentElement.setAttribute(SIDEBAR_STATE_ATTRIBUTE, value);
  const cookieStore =
    "cookieStore" in globalThis ? globalThis.cookieStore : undefined;
  // Both persistence paths retain toggle order when an earlier write is slow.
  const save = async () => {
    if (cookieStore === undefined) {
      await persist({ data: open });
      return;
    }
    await cookieStore.set({
      name: SIDEBAR_STATE_COOKIE,
      value,
      path: "/",
      sameSite: "lax",
      expires: Temporal.Now.instant().add({
        hours: SIDEBAR_STATE_LIFETIME_HOURS,
      }).epochMilliseconds,
    });
  };
  const pending = sidebarPersistence.then(save, save);
  sidebarPersistence = pending;
  detached(pending, "sidebar-state.persist");
};
