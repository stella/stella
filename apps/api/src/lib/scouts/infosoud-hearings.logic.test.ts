import { describe, expect, test } from "bun:test";

import {
  findPreviousStart,
  HEARING_SOON_WINDOW_MS,
  hearingSeverity,
  toHearingRecord,
} from "@/api/lib/scouts/infosoud-hearings.logic";
import type { HearingRecord } from "@/api/lib/scouts/infosoud-hearings.logic";

const NOW = new Date("2026-08-21T09:00:00.000Z");

/** Shaped like `buildHearingAgendaItem` output in agenda-import.ts. */
const hearingExternalData = (overrides: {
  date: string;
  time: string;
  type?: string | null;
  cancelled?: boolean | null;
}) => ({
  case: {
    caseMark: "12 C 45/2026",
    court: "Krajský soud v Praze",
    parentCourt: "Vrchní soud v Praze",
  },
  hearing: {
    cancelled: overrides.cancelled ?? false,
    date: overrides.date,
    judge: "JUDr. Nováková",
    private: false,
    result: null,
    room: "č. 12",
    subject: "žaloba o zaplacení",
    time: overrides.time,
    type: overrides.type === undefined ? "Jednání" : overrides.type,
  },
  source: "infosoud",
});

const record = (
  externalId: string,
  startAt: string,
  extra: Partial<HearingRecord> = {},
): HearingRecord => ({
  externalId: `infosoud:hearing:${externalId}`,
  caseMark: "12 C 45/2026",
  court: "Krajský soud v Praze",
  hearingType: "Jednání",
  startAt: new Date(startAt),
  cancelled: false,
  date: startAt.slice(0, 10),
  time: startAt.slice(11, 16),
  ...extra,
});

describe("toHearingRecord", () => {
  test("narrows a hearing entity and rejects an event entity", () => {
    const hearing = toHearingRecord({
      externalId: "infosoud:hearing:abc",
      externalData: hearingExternalData({
        date: "03.09.2026",
        time: "09:30",
      }),
      startAt: new Date("2026-09-03T07:30:00.000Z"),
    });
    expect(hearing).toEqual({
      externalId: "infosoud:hearing:abc",
      caseMark: "12 C 45/2026",
      court: "Krajský soud v Praze",
      hearingType: "Jednání",
      startAt: new Date("2026-09-03T07:30:00.000Z"),
      cancelled: false,
      date: "03.09.2026",
      time: "09:30",
    });
    expect(
      toHearingRecord({
        externalId: "infosoud:event:abc",
        externalData: {
          case: { caseMark: "12 C 45/2026", court: "KS Praha" },
          event: { type: "Podání", date: "01.08.2026" },
        },
        startAt: null,
      }),
    ).toBeNull();
  });
});

describe("findPreviousStart", () => {
  const existing = [
    record("old", "2026-09-03T07:30:00.000Z"),
    record("other-type", "2026-08-25T07:30:00.000Z", {
      hearingType: "Vyhlášení rozsudku",
    }),
    record("cancelled", "2026-09-10T07:30:00.000Z", { cancelled: true }),
  ];

  test("a same-case same-type earlier hearing is a reschedule", () => {
    const moved = record("new", "2026-08-28T07:30:00.000Z");
    expect(findPreviousStart(moved, existing)).toEqual(
      new Date("2026-09-03T07:30:00.000Z"),
    );
  });

  test("cancelled and other-type hearings never count as the previous one", () => {
    const sentencing = record("new", "2026-09-20T07:30:00.000Z", {
      hearingType: "Vyhlášení rozsudku",
    });
    expect(findPreviousStart(sentencing, existing)).toEqual(
      new Date("2026-08-25T07:30:00.000Z"),
    );
    const onlyCancelled = [
      record("c", "2026-09-10T07:30:00.000Z", {
        cancelled: true,
      }),
    ];
    expect(
      findPreviousStart(
        record("new", "2026-09-20T07:30:00.000Z"),
        onlyCancelled,
      ),
    ).toBeNull();
  });

  test("the hearing's own id is not its previous occurrence (mutation guard)", () => {
    const same = record("old", "2026-09-03T07:30:00.000Z");
    // The fixture shares its id with `existing[0]`; without the id filter
    // the function would return the hearing's own start.
    expect(existing[0]?.externalId).toBe(same.externalId);
    expect(findPreviousStart(same, [existing[0]!])).toBeNull();
  });
});

describe("hearingSeverity", () => {
  test("reschedules and near hearings warn, distant first listings notify", () => {
    const distant = record("d", "2026-12-01T09:00:00.000Z");
    const soon = record(
      "s",
      new Date(NOW.getTime() + HEARING_SOON_WINDOW_MS - 60_000).toISOString(),
    );
    const justOutside = record(
      "o",
      new Date(NOW.getTime() + HEARING_SOON_WINDOW_MS + 60_000).toISOString(),
    );
    expect(hearingSeverity(distant, null, NOW)).toBe("notice");
    expect(hearingSeverity(distant, new Date("2026-11-01"), NOW)).toBe(
      "warning",
    );
    expect(hearingSeverity(soon, null, NOW)).toBe("warning");
    expect(hearingSeverity(justOutside, null, NOW)).toBe("notice");
  });
});
