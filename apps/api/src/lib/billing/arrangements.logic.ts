export const evaluateBillingCap = ({
  totalAmount,
  capAmount,
  alertThresholdBps,
}: {
  totalAmount: bigint;
  capAmount: bigint;
  alertThresholdBps: number;
}) =>
  ({
    thresholdState:
      totalAmount * 10_000n >= capAmount * BigInt(alertThresholdBps)
        ? "above"
        : "below",
    capState: totalAmount >= capAmount ? "above" : "below",
  }) as const;

export const newBillingCapCrossings = ({
  previous,
  current,
}: {
  previous: { thresholdState: "below" | "above"; capState: "below" | "above" };
  current: { thresholdState: "below" | "above"; capState: "below" | "above" };
}) => {
  const crossings: ("threshold" | "cap")[] = [];
  if (
    previous.thresholdState === "below" &&
    current.thresholdState === "above"
  ) {
    crossings.push("threshold");
  }
  if (previous.capState === "below" && current.capState === "above") {
    crossings.push("cap");
  }
  return crossings;
};
