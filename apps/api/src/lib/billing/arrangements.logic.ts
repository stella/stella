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

type EvaluateBillingArrangementCapsOptions = {
  totalAmount: bigint;
  totalMinutes: bigint;
  capAmount: number | null;
  capMinutes: number | null;
  alertThresholdBps: number;
};

export const evaluateBillingArrangementCaps = ({
  totalAmount,
  totalMinutes,
  capAmount,
  capMinutes,
  alertThresholdBps,
}: EvaluateBillingArrangementCapsOptions) => ({
  amount:
    capAmount === null
      ? ({ thresholdState: "below", capState: "below" } as const)
      : evaluateBillingCap({
          totalAmount,
          capAmount: BigInt(capAmount),
          alertThresholdBps,
        }),
  minutes:
    capMinutes === null
      ? ({ thresholdState: "below", capState: "below" } as const)
      : evaluateBillingCap({
          totalAmount: totalMinutes,
          capAmount: BigInt(capMinutes),
          alertThresholdBps,
        }),
});

type ExceedsBillingCapsOptions = {
  totalAmount: bigint;
  totalMinutes: bigint;
  capAmount: number | null;
  capMinutes: number | null;
};

export const exceedsBillingCaps = ({
  totalAmount,
  totalMinutes,
  capAmount,
  capMinutes,
}: ExceedsBillingCapsOptions) =>
  (capAmount !== null && totalAmount > BigInt(capAmount)) ||
  (capMinutes !== null && totalMinutes > BigInt(capMinutes));
