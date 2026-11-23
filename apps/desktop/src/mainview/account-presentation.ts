import { panic } from "better-result";

import type {
  DesktopAccountSnapshot,
  LinkedAccountSnapshot,
} from "../shared/rpc";

export type DesktopAccountState =
  DesktopAccountSnapshot | { status: "loading" } | { status: "unavailable" };

/** The host a person recognises ("my.stll.app"), not the full origin. */
export const serverHost = (origin: string) => {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
};

/**
 * One presentation per account state, so the settings card always shows
 * which server it talks to, what is wrong, and the single action that fixes
 * it.
 */
export const accountPresentation = (state: DesktopAccountState) => {
  switch (state.status) {
    case "connected":
      return {
        actionKey: "disconnect",
        actionVariant: "ghost",
        descriptionKey: null,
        host: serverHost(state.server),
        status: "linked",
        statusKey: "accountLinked",
      } as const;
    case "expired":
      return {
        actionKey: "reconnect",
        actionVariant: "default",
        descriptionKey: "reconnectHostDescription",
        host: serverHost(state.server),
        status: "attention",
        statusKey: "connectionExpired",
      } as const;
    case "reconnectRequired":
      return {
        actionKey: "reconnect",
        actionVariant: "default",
        descriptionKey: "reconnectHostDescription",
        host: serverHost(state.server),
        status: "attention",
        statusKey: "reconnectNeeded",
      } as const;
    case "disconnected":
      return {
        actionKey: "connectToHost",
        actionVariant: "default",
        descriptionKey: "connectToHostDescription",
        host: serverHost(state.server),
        status: "not-linked",
        statusKey: "notConnected",
      } as const;
    case "loading":
      return {
        actionKey: "connectToStella",
        actionVariant: "outline",
        descriptionKey: null,
        host: null,
        status: "loading",
        statusKey: "notAvailableYet",
      } as const;
    case "unavailable":
      return {
        actionKey: "tryAgain",
        actionVariant: "outline",
        descriptionKey: "errorReadAccount",
        host: null,
        status: "unavailable",
        statusKey: "notAvailableYet",
      } as const;
    default:
      state satisfies never;
      return panic("Unknown desktop account state");
  }
};

type AccountStatus = ReturnType<typeof accountPresentation>["status"];

/** The status dot's tone; null while the account is still being read, when
 *  there is nothing to say yet. */
export const accountStatusTone = (status: AccountStatus) => {
  switch (status) {
    case "linked":
      return "success";
    case "attention":
      return "warning";
    case "not-linked":
    case "unavailable":
      return "neutral";
    case "loading":
      return null;
    default:
      status satisfies never;
      return panic("Unknown desktop account status");
  }
};

/**
 * The account picture the native side sends: a base64 raster `data:` URL,
 * the only image source the webview's policy allows besides its own files.
 * Anything else shows the initials.
 */
const ACCOUNT_AVATAR_DATA_URL =
  /^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z\d+/]+={0,2}$/u;

export const accountAvatar = (avatar: string | null) =>
  avatar !== null && ACCOUNT_AVATAR_DATA_URL.test(avatar) ? avatar : null;

const initialsOf = (account: LinkedAccountSnapshot) => {
  const name = account.name?.trim();
  if (name) {
    return name
      .split(/\s+/u)
      .map((part) => part[0])
      .join("")
      .slice(0, 2)
      .toUpperCase();
  }
  return account.email.slice(0, 2).toUpperCase();
};

/** Who the window shows as linked: the name (or the email when there is no
 *  name), initials for the avatar, and the account's presentation. */
export const accountDisplay = (state: DesktopAccountState) => {
  const presentation = accountPresentation(state);
  if (state.status !== "connected") {
    return {
      avatar: null,
      email: null,
      initials: null,
      name: null,
      presentation,
    };
  }
  const { account } = state;
  return {
    avatar: accountAvatar(state.avatar),
    email: account.email,
    initials: initialsOf(account),
    name: account.name?.trim() || account.email,
    presentation,
  };
};
