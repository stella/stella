const ACTIVITY_INTERVAL_MS = 30_000;
const isAccountActivityWindow = (windowLabel: string) =>
  windowLabel === "main" ||
  windowLabel === "clipboard" ||
  windowLabel === "clipboard-editor";

type AccountActivityEligibility = {
  windowLabel: string;
  visibilityState: DocumentVisibilityState;
  eventType: string;
  isTrusted: boolean;
  now: number;
  lastRecordedAt: number | null;
};

export const shouldRecordAccountActivity = ({
  windowLabel,
  visibilityState,
  eventType,
  isTrusted,
  now,
  lastRecordedAt,
}: AccountActivityEligibility) =>
  isAccountActivityWindow(windowLabel) &&
  visibilityState === "visible" &&
  isTrusted &&
  (eventType === "pointerdown" || eventType === "keydown") &&
  (lastRecordedAt === null || now - lastRecordedAt >= ACTIVITY_INTERVAL_MS);

type InstallAccountActivityOptions = {
  document: Document;
  windowLabel: string;
  recordUse: () => Promise<unknown>;
  onFailure: () => void;
  now?: () => number;
};

export const installAccountActivity = ({
  document,
  windowLabel,
  recordUse,
  onFailure,
  now = () => performance.now(),
}: InstallAccountActivityOptions) => {
  if (!isAccountActivityWindow(windowLabel)) {
    return () => undefined;
  }
  let lastRecordedAt: number | null = null;
  const handleActivity = (event: Event) => {
    const timestamp = now();
    if (
      !shouldRecordAccountActivity({
        windowLabel,
        visibilityState: document.visibilityState,
        eventType: event.type,
        isTrusted: event.isTrusted,
        now: timestamp,
        lastRecordedAt,
      })
    ) {
      return;
    }
    // Reserve the interval before IPC; failures and overlapping input cannot
    // turn a held key or pointer gesture into a burst of renewal requests.
    lastRecordedAt = timestamp;
    void recordUse().catch(() => onFailure());
  };
  document.addEventListener("pointerdown", handleActivity, true);
  document.addEventListener("keydown", handleActivity, true);
  return () => {
    document.removeEventListener("pointerdown", handleActivity, true);
    document.removeEventListener("keydown", handleActivity, true);
  };
};
