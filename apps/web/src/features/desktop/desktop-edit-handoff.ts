import { panic, Result, TaggedError } from "better-result";

import type { DesktopHandoffFailureReason } from "@stll/api-contract/desktop-handoff";
import { sleep } from "@stll/concurrency/sleep";
import { Temporal } from "@stll/time";

export class DesktopHandoffFailedError extends TaggedError(
  "DesktopHandoffFailedError",
)<{ message: string; failureReason: DesktopHandoffFailureReason }> {}

type DesktopEditHandoffStatus =
  | { status: "expired"; expiresAt: string }
  | {
      status: "failed";
      failureReason: DesktopHandoffFailureReason;
      failedAt: string;
    }
  | { status: "opened"; sessionId: string }
  | { status: "pending"; expiresAt: string };

type WatchDesktopEditHandoffOptions = {
  expiresAt: string;
  readStatus: () => Promise<DesktopEditHandoffStatus>;
};

export const DESKTOP_HANDOFF_POLL_INTERVAL_MS = 750;

/** Return immediately on a terminal response, retaining the recovery reason. */
export const watchDesktopEditHandoff = async ({
  expiresAt,
  readStatus,
}: WatchDesktopEditHandoffOptions): Promise<
  Result<"opened" | "expired", DesktopHandoffFailedError>
> => {
  const parsedDeadline = new Date(expiresAt).getTime();
  let deadline = Number.isFinite(parsedDeadline)
    ? parsedDeadline
    : Temporal.Now.instant().epochMilliseconds + 30_000;
  while (Temporal.Now.instant().epochMilliseconds < deadline) {
    const handoffStatus = await readStatus();
    switch (handoffStatus.status) {
      case "opened":
        return Result.ok("opened");
      case "failed":
        return Result.err(
          new DesktopHandoffFailedError({
            message: handoffStatus.failureReason,
            failureReason: handoffStatus.failureReason,
          }),
        );
      case "expired":
        return Result.ok("expired");
      case "pending": {
        const nextDeadline = new Date(handoffStatus.expiresAt).getTime();
        if (Number.isFinite(nextDeadline) && nextDeadline > deadline) {
          deadline = nextDeadline;
        }
        const delayMs = Math.max(
          0,
          Math.min(
            DESKTOP_HANDOFF_POLL_INTERVAL_MS,
            deadline - Temporal.Now.instant().epochMilliseconds,
          ),
        );
        await sleep(delayMs);
        break;
      }
      default:
        handoffStatus satisfies never;
        return panic("Unhandled desktop handoff status");
    }
  }
  return Result.ok("expired");
};
