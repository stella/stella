import { panic } from "better-result";

import type { DesktopLinkFailure } from "./desktop-rpc.gen";

/**
 * What a `stella://account/connect` link asks the app for. Only `switch` may
 * replace an account already linked there, and only after the member
 * confirms it in the app's own window.
 */
export type DesktopLinkIntent = "connect" | "switch";

type DesktopAccountConnectUrlOptions = {
  apiBaseUrl: string;
  webOrigin: string;
  intent: DesktopLinkIntent;
};

export const desktopAccountConnectUrl = ({
  apiBaseUrl,
  webOrigin,
  intent,
}: DesktopAccountConnectUrlOptions) =>
  `stella://account/connect?${new URLSearchParams({ apiBaseUrl, webOrigin, intent }).toString()}`;

const DESKTOP_LINK_FAILURES = {
  account_conflict: true,
  switch_declined: true,
  declined: true,
  update_required: true,
  unavailable: true,
} as const satisfies Record<DesktopLinkFailure, true>;

const isDesktopLinkFailure = (value: unknown): value is DesktopLinkFailure =>
  typeof value === "string" && Object.hasOwn(DESKTOP_LINK_FAILURES, value);

/** A browser link as the app reports it over the loopback bridge. */
export type DesktopLinkStatus =
  | { status: "pending" }
  | { status: "connected" }
  | { status: "failed"; reason: DesktopLinkFailure };

/** Reads a bridge status; anything outside the contract is `null`. */
export const parseDesktopLinkStatus = (
  value: unknown,
): DesktopLinkStatus | null => {
  if (typeof value !== "object" || value === null || !("status" in value)) {
    return null;
  }
  switch (value.status) {
    case "pending":
      return { status: "pending" };
    case "connected":
      return { status: "connected" };
    case "failed":
      return "reason" in value && isDesktopLinkFailure(value.reason)
        ? { status: "failed", reason: value.reason }
        : null;
    default:
      return null;
  }
};

/**
 * The status line the app signs: `pending`, `connected` or `failed:<reason>`,
 * so a page never acts on a reason the app did not sign.
 */
export const signedDesktopLinkStatus = (status: DesktopLinkStatus) => {
  switch (status.status) {
    case "pending":
    case "connected":
      return status.status;
    case "failed":
      return `failed:${status.reason}`;
    default:
      status satisfies never;
      return panic("Unhandled desktop connection status");
  }
};
