import { panic } from "better-result";

export const CONFIGURED_ACCESS_STATE = "configured_access" as const;

export const CONFIGURED_ACCESS_STATUSES = [
  "active",
  "ending",
  "payment_retry",
  "disabled",
] as const;

export type ConfiguredAccess =
  | {
      status: "active" | "ending";
      periodEndsAt: Date;
      serviceActionsPerPeriod: number;
    }
  | {
      status: "payment_retry";
      periodEndsAt: Date;
      retryEndsAt: Date;
      serviceActionsPerPeriod: number;
    }
  | { status: "disabled" };

export type ConfiguredAccessEvent =
  | {
      type: "active";
      periodEndsAt: Date;
      serviceActionsPerPeriod: number | null;
      cancelAtPeriodEnd: boolean;
    }
  | { type: "cancel" }
  | { type: "payment_retry"; occurredAt: Date; retryWindowMs: number }
  | { type: "deny" };

export const transitionConfiguredAccess = (
  current: ConfiguredAccess | null,
  event: ConfiguredAccessEvent,
): ConfiguredAccess => {
  switch (event.type) {
    case "active":
      if (
        event.cancelAtPeriodEnd &&
        current !== null &&
        current.status !== "disabled"
      ) {
        return transitionConfiguredAccess(current, { type: "cancel" });
      }
      if (event.serviceActionsPerPeriod === null) {
        return { status: "disabled" };
      }
      return {
        status: event.cancelAtPeriodEnd ? "ending" : "active",
        periodEndsAt: event.periodEndsAt,
        serviceActionsPerPeriod: event.serviceActionsPerPeriod,
      };
    case "cancel":
      if (current === null || current.status === "disabled") {
        return { status: "disabled" };
      }
      if (current.status === "payment_retry") {
        return {
          status: "payment_retry",
          periodEndsAt: current.periodEndsAt,
          retryEndsAt: new Date(
            Math.min(
              current.periodEndsAt.getTime(),
              current.retryEndsAt.getTime(),
            ),
          ),
          serviceActionsPerPeriod: current.serviceActionsPerPeriod,
        };
      }
      return {
        status: "ending",
        periodEndsAt: current.periodEndsAt,
        serviceActionsPerPeriod: current.serviceActionsPerPeriod,
      };
    case "payment_retry":
      if (current === null || current.status === "disabled") {
        return { status: "disabled" };
      }
      if (current.status === "payment_retry") {
        return current;
      }
      return {
        status: "payment_retry",
        periodEndsAt: current.periodEndsAt,
        retryEndsAt: new Date(
          current.status === "ending"
            ? Math.min(
                current.periodEndsAt.getTime(),
                event.occurredAt.getTime() + event.retryWindowMs,
              )
            : event.occurredAt.getTime() + event.retryWindowMs,
        ),
        serviceActionsPerPeriod: current.serviceActionsPerPeriod,
      };
    case "deny":
      return { status: "disabled" };
    default:
      event satisfies never;
      return panic("Unhandled configured access event");
  }
};

export const configuredAccessDeadline = (
  access: ConfiguredAccess,
): Date | null => {
  switch (access.status) {
    case "active":
    case "ending":
      return access.periodEndsAt;
    case "payment_retry":
      return access.retryEndsAt;
    case "disabled":
      return null;
    default:
      access satisfies never;
      return panic("Unhandled configured access status");
  }
};

export const configuredPaymentRetry = (
  access: ConfiguredAccess | null,
  now: Date,
) =>
  access?.status === "payment_retry" && access.retryEndsAt > now
    ? {
        status: "payment_retry" as const,
        endsAt: access.retryEndsAt.toISOString(),
      }
    : { status: "none" as const };
