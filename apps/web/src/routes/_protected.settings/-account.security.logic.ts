import { panic } from "better-result";
import * as v from "valibot";

import {
  SESSION_SIGN_IN_REVIEW,
  type SessionSignInLocation,
  type SessionSignInReview,
  sessionSignInReviewBodySchema,
} from "@stll/api-contract/session-sign-ins";
import {
  DEVICE_KIND,
  type DeviceKind,
  parseDeviceKind,
  parseUserAgent,
} from "@stll/user-agent";

import { routeSearchSchema } from "@/route-search-params";

/**
 * `review` names the sign-in the new-device email asked about; a malformed
 * value falls back to no review rather than failing the page.
 */
export const securitySearchSchema = routeSearchSchema({
  review: v.fallback(
    v.optional(sessionSignInReviewBodySchema.entries.sessionId),
    undefined,
  ),
});

/** One live session as the sessions list returns it. */
export type ListedSession = {
  id: string;
  userAgent?: string | null | undefined;
  ipAddress?: string | null | undefined;
  createdAt: Date;
  updatedAt: Date;
  originClientName: string | null;
};

/** One sign-in as `GET /session-sign-ins` returns it. */
export type ListedSignIn = {
  id: string;
  location: SessionSignInLocation;
  review: SessionSignInReview;
};

/**
 * What names a device: its browser and operating system as the user agent
 * gives them. The page words them in its language.
 */
export type DeviceName =
  | { type: "browserOnOs"; browser: string; os: string }
  | { type: "browser"; browser: string }
  | { type: "os"; os: string }
  | { type: "desktopApp" }
  | { type: "unknown" };

/** A signed-in device, as the security page shows it. */
export type SignedInDevice = {
  id: string;
  kind: DeviceKind;
  name: DeviceName;
  ipAddress: string | null;
  signedInAt: Date;
  lastActiveAt: Date;
  location: SessionSignInLocation;
  review: SessionSignInReview;
  /** The connected app a handed-off session came from. */
  originClientName: string | null;
};

const UNRECORDED_SIGN_IN = {
  location: { type: "unknown" },
  review: SESSION_SIGN_IN_REVIEW.notRequired,
} as const satisfies Omit<ListedSignIn, "id">;

const deviceName = (
  kind: DeviceKind,
  userAgent: string | null | undefined,
): DeviceName => {
  if (kind === DEVICE_KIND.desktopApp) {
    return { type: "desktopApp" };
  }
  const { browser, os } = parseUserAgent(userAgent);
  if (browser !== null && os !== null) {
    return { type: "browserOnOs", browser, os };
  }
  if (browser !== null) {
    return { type: "browser", browser };
  }
  return os === null ? { type: "unknown" } : { type: "os", os };
};

const knownAddress = (ipAddress: string | null | undefined): string | null =>
  ipAddress === undefined || ipAddress === null || ipAddress === ""
    ? null
    : ipAddress;

/**
 * Joins the sessions list with each session's sign-in details, most recently
 * active first. A session the sign-in list has not seen yet (it began after
 * that list was read) shows an unknown location until the next read; it is
 * never dropped.
 */
export const signedInDevices = (
  sessions: readonly ListedSession[],
  signIns: readonly ListedSignIn[],
): SignedInDevice[] => {
  const signInsById = new Map(signIns.map((signIn) => [signIn.id, signIn]));
  return sessions
    .map((session) => {
      const kind = parseDeviceKind(session.userAgent);
      const signIn = signInsById.get(session.id) ?? UNRECORDED_SIGN_IN;
      return {
        id: session.id,
        kind,
        name: deviceName(kind, session.userAgent),
        ipAddress: knownAddress(session.ipAddress),
        signedInAt: session.createdAt,
        lastActiveAt: session.updatedAt,
        location: signIn.location,
        review: signIn.review,
        originClientName: session.originClientName,
      };
    })
    .toSorted((a, b) => b.lastActiveAt.getTime() - a.lastActiveAt.getTime());
};

const reviewRank = ({ review }: SignedInDevice): number =>
  review === SESSION_SIGN_IN_REVIEW.pending ? 0 : 1;

/** The devices other than this one, with those waiting for review first. */
export const otherDevices = (
  devices: readonly SignedInDevice[],
  currentSessionId: string | undefined,
): SignedInDevice[] =>
  devices
    .filter((device) => device.id !== currentSessionId)
    .toSorted((a, b) => reviewRank(a) - reviewRank(b));

export const pendingReviews = (
  devices: readonly SignedInDevice[],
): SignedInDevice[] =>
  devices.filter((device) => device.review === SESSION_SIGN_IN_REVIEW.pending);

/**
 * What the review card shows for the sign-in a link named. `signedOut` comes
 * from the page's own memory that it just signed that device out, which the
 * refreshed list can no longer say; `gone` is a named sign-in that is no
 * longer among the live sessions.
 */
export type ReviewCardState =
  | { type: "none" }
  | { type: "ask"; device: SignedInDevice }
  | { type: "confirmed"; device: SignedInDevice }
  | { type: "signedOut"; deviceName: DeviceName }
  | { type: "gone" };

export type ReviewOutcome =
  { type: "undecided" } | { type: "signedOut"; deviceName: DeviceName };

type ReviewCardStateOptions = {
  targetSessionId: string | undefined;
  devices: readonly SignedInDevice[];
  outcome: ReviewOutcome;
};

export const reviewCardState = ({
  targetSessionId,
  devices,
  outcome,
}: ReviewCardStateOptions): ReviewCardState => {
  if (targetSessionId === undefined) {
    return { type: "none" };
  }
  if (outcome.type === "signedOut") {
    return { type: "signedOut", deviceName: outcome.deviceName };
  }
  const device = devices.find(({ id }) => id === targetSessionId);
  if (device === undefined) {
    return { type: "gone" };
  }
  switch (device.review) {
    case SESSION_SIGN_IN_REVIEW.pending:
      return { type: "ask", device };
    case SESSION_SIGN_IN_REVIEW.confirmed:
      return { type: "confirmed", device };
    case SESSION_SIGN_IN_REVIEW.notRequired:
      return { type: "none" };
    default:
      device.review satisfies never;
      return panic("Unknown sign-in review status");
  }
};
