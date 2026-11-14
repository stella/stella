import { Result } from "better-result";

import { type ParsedUserAgent, parseUserAgent } from "@stll/user-agent";

import { isNewDeviceNoticeAuthPath } from "@/api/lib/auth/session-path-classification";
import type { SafeId } from "@/api/lib/branded-types";

const SIGN_IN_EMAIL_PATH = "/sign-in/email";

type NewDeviceNoticeSession = {
  user: {
    id: SafeId<"user">;
    email: string;
  };
  session: {
    id: string;
    ipAddress: string | null | undefined;
    userAgent: string | null | undefined;
    createdAt: Date;
  };
};

type PreviousSession = {
  ipAddress: string | null;
  userAgent: string | null;
};

type NewDeviceNotice = {
  email: string;
  device: string;
  ipAddress: string;
  createdAt: Date;
};

type NewDeviceNoticeDependencies = {
  findPreviousSessions: (
    userId: SafeId<"user">,
    sessionId: string,
  ) => Promise<PreviousSession[]>;
  sendNotice: (notice: NewDeviceNotice) => void;
  isTransactionalEmailConfigured: () => boolean;
  isLocalDev: () => boolean;
  onError: (error: unknown) => void;
};

type SendNewDeviceNoticeOptions = {
  path: string | undefined;
  newSession: NewDeviceNoticeSession | null;
  dependencies: NewDeviceNoticeDependencies;
};

// A device is its browser and OS; a user agent naming neither is no device.
const deviceKey = ({ browser, os }: ParsedUserAgent): string | null =>
  browser === null && os === null ? null : `${browser ?? ""}|${os ?? ""}`;

export const sendNewDeviceNotice = async ({
  path,
  newSession,
  dependencies,
}: SendNewDeviceNoticeOptions): Promise<void> => {
  if (!isNewDeviceNoticeAuthPath(path) || dependencies.isLocalDev()) {
    return;
  }

  if (
    path === SIGN_IN_EMAIL_PATH &&
    !dependencies.isTransactionalEmailConfigured()
  ) {
    return;
  }

  if (!newSession) {
    return;
  }

  const notified = await Result.tryPromise({
    try: async () => {
      const { user, session } = newSession;
      const previousSessions = await dependencies.findPreviousSessions(
        user.id,
        session.id,
      );

      if (previousSessions.length === 0) {
        return;
      }

      const knownIPs = new Set<string>();
      const knownDevices = new Set<string>();
      for (const previous of previousSessions) {
        if (previous.ipAddress) {
          knownIPs.add(previous.ipAddress);
        }
        const previousDeviceKey = deviceKey(
          parseUserAgent(previous.userAgent ?? undefined),
        );
        if (previousDeviceKey !== null) {
          knownDevices.add(previousDeviceKey);
        }
      }

      const currentDevice = parseUserAgent(session.userAgent ?? undefined);
      const currentDeviceKey = deviceKey(currentDevice);
      const currentIpAddress = session.ipAddress;
      const isNewIP =
        typeof currentIpAddress === "string" && !knownIPs.has(currentIpAddress);
      const isNewDevice =
        currentDeviceKey !== null && !knownDevices.has(currentDeviceKey);

      if (!isNewIP && !isNewDevice) {
        return;
      }

      const device =
        currentDevice.browser && currentDevice.os
          ? `${currentDevice.browser} on ${currentDevice.os}`
          : (currentDevice.browser ?? currentDevice.os ?? "Unknown");
      dependencies.sendNotice({
        email: user.email,
        device,
        ipAddress: session.ipAddress ?? "Unknown",
        createdAt: session.createdAt,
      });
    },
    catch: (cause) => cause,
  });
  if (Result.isError(notified)) {
    dependencies.onError(notified.error);
  }
};
