import { afterEach, describe, expect, setSystemTime, test } from "bun:test";

import { useAvtStore } from "@/routes/dev_.avt/-components/avt/avt-store";

afterEach(() => {
  setSystemTime();
  useAvtStore.setState({ reviews: {} });
});

describe("AVT review decision timestamps", () => {
  test("records the time of direct status and override decisions", () => {
    setSystemTime(new Date("2026-01-01T12:00:00Z"));
    useAvtStore.getState().setReviewStatus("claim-1", "reviewed");
    const statusStamp = useAvtStore.getState().reviews["claim-1"]?.decisionAt;

    setSystemTime(new Date("2026-01-02T12:00:00Z"));
    useAvtStore.getState().setOverride("claim-1", "supported");
    const overrideStamp = useAvtStore.getState().reviews["claim-1"]?.decisionAt;

    expect(statusStamp).not.toBeNull();
    expect(overrideStamp).not.toBeNull();
    expect(overrideStamp).not.toBe(statusStamp);
  });

  test("clears stale dispositions when a record conflict changes", () => {
    useAvtStore.setState({
      reviews: {
        "claim-1": {
          status: "reviewed",
          override: "supported",
          note: "Keep this note",
          savedAt: "2026-01-01 12:00",
          decisionAt: "2026-01-01T12:00:00.000Z",
        },
      },
    });

    useAvtStore
      .getState()
      .resolveRecordConflict("claim-1", { kind: "escalated" });

    expect(useAvtStore.getState().reviews["claim-1"]).toMatchObject({
      status: null,
      override: null,
      note: "Keep this note",
      savedAt: "2026-01-01 12:00",
      recordConflictResolution: { kind: "escalated" },
    });
  });
});
