const CONSUMED_HANDOFF_OPEN_ACK_GRACE_MS = 60_000;

export type DesktopEditHandoffStatusResponse =
  | { status: "expired"; expiresAt: string }
  | { status: "opened"; sessionId: string }
  | { status: "pending"; expiresAt: string };

type ResolveDesktopEditHandoffStatusInput = {
  consumedAt: Date | null;
  desktopSessionId: string | null;
  expiresAt: Date;
  now: Date;
  openedAt: Date | null;
};

export const resolveDesktopEditHandoffStatus = ({
  consumedAt,
  desktopSessionId,
  expiresAt,
  now,
  openedAt,
}: ResolveDesktopEditHandoffStatusInput): DesktopEditHandoffStatusResponse => {
  if (openedAt && desktopSessionId) {
    return {
      status: "opened",
      sessionId: desktopSessionId,
    };
  }

  const pendingUntil =
    consumedAt === null
      ? expiresAt
      : new Date(consumedAt.getTime() + CONSUMED_HANDOFF_OPEN_ACK_GRACE_MS);

  if (pendingUntil.getTime() <= now.getTime()) {
    return {
      status: "expired",
      expiresAt: pendingUntil.toISOString(),
    };
  }

  return {
    status: "pending",
    expiresAt: pendingUntil.toISOString(),
  };
};
