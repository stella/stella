type SettlingDeadlineOptions = {
  hardDeadlineMs: number;
  settleMarginMs: number;
  timeoutSignal?: (delayMs: number) => AbortSignal;
};

/** Creates a cooperative deadline that leaves time before the hard backstop. */
export const createSettlingDeadlineSignal = ({
  hardDeadlineMs,
  settleMarginMs,
  timeoutSignal = (delayMs) => AbortSignal.timeout(delayMs),
}: SettlingDeadlineOptions): AbortSignal =>
  timeoutSignal(Math.max(0, hardDeadlineMs - settleMarginMs));
