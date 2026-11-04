import { describe, expect, test } from "bun:test";

import type { TimerActivityTimer } from "@stll/api-contract/timer-activity";

import type { TimestampCasToken } from "@/api/lib/db/timestamp-cas";
import type { ApnsActivityPush, ApnsOutcome } from "@/api/lib/push/apns-client";
import type { TimerActivityDevice } from "@/api/lib/push/timer-activity-devices";
import {
  scheduleTimerActivityUpdates,
  updateTimerActivities,
} from "@/api/lib/push/timer-activity-queue";
import type { TimerActivityDeps } from "@/api/lib/push/timer-activity-queue";
import {
  brandPersistedOrganizationId,
  brandPersistedUserId,
} from "@/api/lib/safe-id-boundaries";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

const NOW = Date.parse("2026-11-04T10:00:00Z");
const JOB = { organizationId: "org-1", userId: "user-1" };

const device = (
  deviceId: string,
  overrides: Partial<TimerActivityDevice> = {},
): TimerActivityDevice => ({
  activityToken: `${deviceId}a`.padEnd(64, "a"),
  bundleId: "app.stll.mobile.preview",
  details: true,
  deviceId,
  environment: "production",
  link: "app.stll.preview://timers",
  locale: "en",
  seenToken: asTestRaw<TimestampCasToken>("2026-11-04 09:00:00+00"),
  startToken: `${deviceId}b`.padEnd(64, "b"),
  startedAt: null,
  ...overrides,
});

const RUNNING: TimerActivityTimer = {
  accumulatedSeconds: 0,
  description: "Call",
  id: "t1",
  lastResumedAt: "2026-11-04T09:59:00Z",
  matterId: null,
  state: "running",
};

/** Fake storage and gateway that answer `outcome` and record what happened. */
const fakeDeps = ({
  devices,
  timers,
  outcome = () => ({ type: "delivered" }),
  claim = true,
}: {
  devices: TimerActivityDevice[];
  timers: TimerActivityTimer[];
  outcome?: (push: ApnsActivityPush) => ApnsOutcome;
  claim?: boolean;
}) => {
  const log: string[] = [];
  const deps: TimerActivityDeps = {
    listDevices: async () =>
      await Promise.resolve({ type: "complete", rows: devices }),
    readTimers: async () =>
      await Promise.resolve({ timers, matterNames: new Map() }),
    claimStart: async (_, { deviceId }) => {
      log.push(`claim ${deviceId}`);
      return await Promise.resolve(claim);
    },
    releaseStart: async (_, { deviceId }) => {
      log.push(`release ${deviceId}`);
      await Promise.resolve();
    },
    forgetToken: async (_, { deviceId }, token) => {
      log.push(`forget ${token} ${deviceId}`);
      await Promise.resolve();
    },
    send: async (push) => {
      log.push(`send ${push.payload.aps.event} ${push.token.slice(0, 2)}`);
      return await Promise.resolve(outcome(push));
    },
    now: () => NOW,
  };
  return { deps, log };
};

describe("updating a person's Lock Screens", () => {
  test("updates every phone that shows the activity", async () => {
    const { deps, log } = fakeDeps({
      devices: [device("p1"), device("p2")],
      timers: [RUNNING],
    });
    expect(await updateTimerActivities(JOB, deps)).toEqual({
      status: "sent",
      sent: 2,
      retryable: 0,
      rejected: [],
    });
    expect(log.toSorted()).toEqual(["send update p1", "send update p2"]);
  });

  test("ends the activity when the last timer is gone, then forgets its token", async () => {
    const { deps, log } = fakeDeps({ devices: [device("p1")], timers: [] });
    await updateTimerActivities(JOB, deps);
    expect(log).toEqual(["send end p1", "forget activity p1"]);
  });

  test("starts an activity only once its start is claimed", async () => {
    const shows = device("p1", { activityToken: null });
    const claimed = fakeDeps({ devices: [shows], timers: [RUNNING] });
    await updateTimerActivities(JOB, claimed.deps);
    expect(claimed.log).toEqual(["claim p1", "send start p1"]);

    const taken = fakeDeps({
      devices: [shows],
      timers: [RUNNING],
      claim: false,
    });
    expect(await updateTimerActivities(JOB, taken.deps)).toMatchObject({
      sent: 0,
    });
    expect(taken.log).toEqual(["claim p1"]);
  });

  test("gives a start back when Apple did not take it, so a retry may send it", async () => {
    const { deps, log } = fakeDeps({
      devices: [device("p1", { activityToken: null })],
      timers: [RUNNING],
      outcome: () => ({ type: "retry", reason: "ServiceUnavailable" }),
    });
    expect(await updateTimerActivities(JOB, deps)).toMatchObject({
      retryable: 1,
    });
    expect(log).toEqual(["claim p1", "send start p1", "release p1"]);
  });

  test("forgets a token Apple calls dead", async () => {
    const { deps, log } = fakeDeps({
      devices: [device("p1")],
      timers: [RUNNING],
      outcome: () => ({ type: "device_gone", reason: "Unregistered" }),
    });
    await updateTimerActivities(JOB, deps);
    expect(log).toEqual(["send update p1", "forget activity p1"]);
  });

  test("reports a refusal a retry would not change", async () => {
    const { deps } = fakeDeps({
      devices: [device("p1")],
      timers: [RUNNING],
      outcome: () => ({
        type: "rejected",
        reason: "PayloadTooLarge",
        status: 413,
      }),
    });
    expect(await updateTimerActivities(JOB, deps)).toMatchObject({
      rejected: [{ reason: "PayloadTooLarge", status: 413 }],
    });
  });

  test("skips a person with no phone, or an invalid job", async () => {
    const { deps, log } = fakeDeps({ devices: [], timers: [RUNNING] });
    expect(await updateTimerActivities(JOB, deps)).toEqual({
      status: "skipped",
      reason: "no_devices",
    });
    expect(
      await updateTimerActivities({ organizationId: "", userId: "u" }, deps),
    ).toEqual({ status: "skipped", reason: "invalid_job" });
    expect(log).toEqual([]);
  });
});

describe("scheduling", () => {
  test("queues nothing while push is off", () => {
    expect(() => {
      scheduleTimerActivityUpdates(
        [
          {
            organizationId: brandPersistedOrganizationId(JOB.organizationId),
            userId: brandPersistedUserId(JOB.userId),
          },
        ],
        { configured: () => false },
      );
    }).not.toThrow();
  });
});
