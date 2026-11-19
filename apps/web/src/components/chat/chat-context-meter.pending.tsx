const RING_RADIUS = 6;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

/** The meter's box: the ring centred in the status row's 24px seat. */
export const CHAT_CONTEXT_METER_BOX_CLASS =
  "text-muted-foreground inline-flex size-6 items-center justify-center";

/** The context ring: a muted track and the share of the window in use. */
export const ContextRing = ({ percent }: { percent: number }) => {
  const filled = (RING_CIRCUMFERENCE * percent) / 100;

  return (
    <svg
      aria-hidden="true"
      className="size-3.5 -rotate-90"
      data-slot="chat-context-ring"
      fill="none"
      viewBox="0 0 16 16"
    >
      <circle
        className="stroke-current opacity-20"
        cx="8"
        cy="8"
        r={RING_RADIUS}
        strokeWidth="2"
      />
      <circle
        className="stroke-current"
        cx="8"
        cy="8"
        r={RING_RADIUS}
        strokeDasharray={`${filled} ${RING_CIRCUMFERENCE}`}
        strokeLinecap="round"
        strokeWidth="2"
      />
    </svg>
  );
};

/** The meter before the thread's usage is known: the empty ring. */
export const ChatContextMeterPending = () => (
  <span
    aria-hidden="true"
    className={CHAT_CONTEXT_METER_BOX_CLASS}
    data-status="pending"
  >
    <ContextRing percent={0} />
  </span>
);
