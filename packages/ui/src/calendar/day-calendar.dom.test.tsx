import { act } from "react";
import type { ComponentProps } from "react";
import { createRoot } from "react-dom/client";

import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { DayCalendar } from "./day-calendar";
import type { DayCalendarColumn } from "./day-calendar";
import {
  DAY_CALENDAR_SLOT_HEIGHT_PX,
  getDayBounds,
} from "./day-calendar.logic";
import type { DayCalendarRange } from "./day-calendar.logic";

const TIME_ZONE = "Europe/Prague";
const DATE = "2026-10-30";
const HOURS = { endHour: 18, startHour: 8 };
const MINUTE_MS = 60_000;
const dayStart = getDayBounds({
  date: DATE,
  ...HOURS,
  timeZone: TIME_ZONE,
}).startMs;
const at = (hour: number, minute = 0) =>
  dayStart + ((hour - HOURS.startHour) * 60 + minute) * MINUTE_MS;

const activityColumn = {
  blocks: [
    {
      accessibleLabel: "Editor, contract review",
      caption: "08:05–08:40",
      endMs: at(8, 40),
      id: "editor",
      kind: "segment",
      startMs: at(8, 5),
      title: "Editor · Service agreement draft",
      tone: {
        color: null,
        matterId: "matter-service-agreement",
        type: "matter",
      },
    },
    {
      accessibleLabel: "Rapid switching",
      endMs: at(9, 5),
      id: "mixed:terminal",
      kind: "mixed",
      startMs: at(8, 40),
      title: "Rapid switching",
      tone: { type: "neutral" },
    },
  ],
  id: "activity",
  label: "Activity",
  rangeSelection: { label: "Select a time range in Activity", type: "enabled" },
  type: "blocks",
} as const satisfies DayCalendarColumn;

const entriesColumn = {
  blocks: [
    {
      accessibleLabel: "Lease review, draft",
      endMs: at(12),
      id: "entry-lease",
      kind: "entry",
      startMs: at(11),
      state: "draft",
      title: "Lease review",
      tone: {
        color: "--option-violet",
        matterId: "matter-lease",
        type: "matter",
      },
    },
  ],
  id: "entries",
  label: "Time entries",
  rangeSelection: { type: "disabled" },
  type: "blocks",
} as const satisfies DayCalendarColumn;

let previousActEnvironment: unknown;

beforeAll(() => {
  GlobalRegistrator.register();
  previousActEnvironment = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
});

afterAll(async () => {
  if (previousActEnvironment === undefined) {
    Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  } else {
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", previousActEnvironment);
  }
  await GlobalRegistrator.unregister();
});

type CalendarProps = ComponentProps<typeof DayCalendar>;

const renderCalendar = async (overrides: Partial<CalendarProps> = {}) => {
  const selected: { columnId: string; range: DayCalendarRange }[] = [];
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const props: CalendarProps = {
    ariaLabel: "Friday",
    columns: [activityColumn, entriesColumn],
    date: DATE,
    granularity: 15,
    hours: HOURS,
    locale: "en-GB",
    nowMs: at(11, 50),
    onSelectRange: (columnId, range) => {
      selected.push({ columnId, range });
    },
    selection: null,
    timeZone: TIME_ZONE,
    ...overrides,
  };
  await act(async () => root.render(<DayCalendar {...props} />));
  const rerender = async (next: Partial<CalendarProps>) => {
    await act(async () => root.render(<DayCalendar {...props} {...next} />));
  };
  const cleanup = async () => {
    await act(async () => root.unmount());
    container.remove();
  };
  return { cleanup, container, rerender, selected };
};

const surfaceOf = (container: HTMLElement, columnId: string) => {
  const surface = container.querySelector<HTMLElement>(
    `[data-column-id="${columnId}"] [data-slot="day-calendar-surface"]`,
  );
  if (surface === null) {
    throw new Error(`No surface for column ${columnId}`);
  }
  // happy-dom has no pointer capture; the calendar captures on pointerdown.
  surface.setPointerCapture = () => undefined;
  return surface;
};

const pointer = async (
  target: HTMLElement,
  type: "pointerdown" | "pointermove" | "pointerup",
  clientY: number,
) => {
  await act(async () => {
    target.dispatchEvent(
      new PointerEvent(type, {
        bubbles: true,
        button: 0,
        clientY,
        pointerId: 1,
      }),
    );
  });
};

const key = async (target: HTMLElement, name: string, shiftKey = false) => {
  await act(async () => {
    target.dispatchEvent(
      new KeyboardEvent("keydown", { bubbles: true, key: name, shiftKey }),
    );
  });
};

const pixelsAt = (minutesFromStart: number, granularity: 15 | 30 | 60) =>
  (minutesFromStart / granularity) * DAY_CALENDAR_SLOT_HEIGHT_PX[granularity];

describe("DayCalendar", () => {
  test("a drag selects a snapped range in the dragged column", async () => {
    const { cleanup, container, selected } = await renderCalendar();
    const surface = surfaceOf(container, "activity");

    // 09:37 down, 10:41 up: the range snaps outward to 09:30–10:45.
    await pointer(surface, "pointerdown", pixelsAt(97, 15));
    await pointer(surface, "pointermove", pixelsAt(160, 15));
    expect(
      container.querySelector<HTMLElement>(
        '[data-slot="day-calendar-selection"]',
      )?.dataset["state"],
    ).toBe("draft");
    await pointer(surface, "pointerup", pixelsAt(161, 15));

    expect(selected).toEqual([
      {
        columnId: "activity",
        range: { endMs: at(10, 45), startMs: at(9, 30) },
      },
    ]);
    expect(
      container.querySelector<HTMLElement>(
        '[data-slot="day-calendar-selection"]',
      ),
    ).toBeNull();
    await cleanup();
  });

  test("a drag past the day's edges is clamped to the day", async () => {
    const { cleanup, container, selected } = await renderCalendar();
    const surface = surfaceOf(container, "activity");

    await pointer(surface, "pointerdown", pixelsAt(9 * 60 + 50, 15));
    await pointer(surface, "pointerup", pixelsAt(12 * 60, 15));

    expect(selected).toEqual([
      { columnId: "activity", range: { endMs: at(18), startMs: at(17, 45) } },
    ]);
    await cleanup();
  });

  test("the keyboard moves, extends, commits and cancels a selection", async () => {
    const { cleanup, container, selected } = await renderCalendar();
    const surface = surfaceOf(container, "activity");

    // The first arrow opens a one-slot selection at the now-line (11:50).
    await key(surface, "ArrowDown");
    await key(surface, "ArrowDown");
    await key(surface, "ArrowDown", true);
    await key(surface, "ArrowDown", true);
    // ICU versions differ in the spacing around the range dash.
    expect(surface.getAttribute("aria-valuetext")).toMatch(
      /^12:00\s*–\s*12:45$/u,
    );
    await key(surface, "Enter");

    expect(selected).toEqual([
      { columnId: "activity", range: { endMs: at(12, 45), startMs: at(12) } },
    ]);

    await key(surface, "ArrowUp");
    expect(
      container.querySelector<HTMLElement>(
        '[data-slot="day-calendar-selection"]',
      ),
    ).not.toBeNull();
    await key(surface, "Escape");
    await key(surface, "Enter");

    expect(selected).toHaveLength(1);
    expect(
      container.querySelector<HTMLElement>(
        '[data-slot="day-calendar-selection"]',
      ),
    ).toBeNull();
    await cleanup();
  });

  test("a keyboard draft is dropped when the day, grid or hours change", async () => {
    const { cleanup, container, rerender, selected } = await renderCalendar();
    const surface = surfaceOf(container, "activity");
    const outline = () =>
      container.querySelector('[data-slot="day-calendar-selection"]');

    for (const change of [
      { date: "2026-10-29" },
      { granularity: 60 },
      { hours: { endHour: 20, startHour: 6 } },
    ] as const satisfies Partial<CalendarProps>[]) {
      await key(surface, "ArrowDown");
      expect(outline()).not.toBeNull();

      await rerender(change);
      expect(outline()).toBeNull();
      await key(surface, "Enter");
      // Returning to the original view does not revive the old draft.
      await rerender({});
      expect(outline()).toBeNull();
      await key(surface, "Enter");
    }

    expect(selected).toEqual([]);
    await cleanup();
  });

  test("labels ranges in a fall-back day's repeated hour with their offset", async () => {
    const hours = { endHour: 6, startHour: 0 };
    // On 2026-10-25 Prague's 02:00 occurs twice: at 00:00Z (CEST, GMT+2) and
    // at 01:00Z (CET, GMT+1).
    const repeatedTwo = Date.UTC(2026, 9, 25, 0);
    const secondTwo = Date.UTC(2026, 9, 25, 1);
    const three = Date.UTC(2026, 9, 25, 2);
    const { cleanup, container, rerender } = await renderCalendar({
      date: "2026-10-25",
      granularity: 60,
      hours,
    });
    const surface = surfaceOf(container, "activity");
    const labelsFor = async (range: DayCalendarRange) => {
      await rerender({
        date: "2026-10-25",
        granularity: 60,
        hours,
        selection: { columnId: "activity", range },
      });
      return {
        outline: container.querySelector('[data-slot="day-calendar-selection"]')
          ?.textContent,
        valueText: surface.getAttribute("aria-valuetext"),
      };
    };

    const first = await labelsFor({ endMs: secondTwo, startMs: repeatedTwo });
    const second = await labelsFor({ endMs: three, startMs: secondTwo });
    const after = await labelsFor({
      endMs: three + 60 * MINUTE_MS,
      startMs: three,
    });

    // ICU versions differ in the spacing around the range dash.
    expect(first.valueText).toMatch(/^02:00 GMT\+2\s*–\s*02:00 GMT\+1$/u);
    expect(second.valueText).toMatch(/^02:00 GMT\+1\s*–\s*03:00 GMT\+1$/u);
    expect(first.outline).toBe("02:00 GMT+202:00 GMT+1");
    expect(second.outline).toBe("02:00 GMT+103:00 GMT+1");
    // Outside the repeated hour, labels carry no offset.
    expect(after.valueText).not.toContain("GMT");
    expect(after.outline).not.toContain("GMT");
    await cleanup();
  });

  test("a short block at the day's end stays inside the grid", async () => {
    const shortBlock = (id: string, startMs: number) =>
      ({
        accessibleLabel: id,
        endMs: startMs + MINUTE_MS,
        id,
        kind: "segment",
        startMs,
        title: id,
        tone: { type: "neutral" },
      }) as const;
    const { cleanup, container } = await renderCalendar({
      columns: [
        {
          ...activityColumn,
          blocks: [
            shortBlock("midday", at(12)),
            shortBlock("last", at(17, 59)),
          ],
        },
      ],
    });
    const wrapperOf = (label: string) => {
      const wrapper = container.querySelector<HTMLElement>(
        `[aria-label="${label}"]`,
      )?.parentElement;
      return {
        bottom:
          Number.parseFloat(wrapper?.style.insetBlockStart ?? "") +
          Number.parseFloat(wrapper?.style.blockSize ?? ""),
        size: Number.parseFloat(wrapper?.style.blockSize ?? ""),
      };
    };
    const gridHeight = pixelsAt((HOURS.endHour - HOURS.startHour) * 60, 15);

    // Mid-day, a one-minute block keeps its visible minimum height.
    expect(wrapperOf("midday").size).toBe(6);
    expect(wrapperOf("last").bottom).toBeCloseTo(gridHeight, 6);
    expect(wrapperOf("last").size).toBeLessThan(6);
    await cleanup();
  });

  test("a block shorter than one label line draws no text but keeps its label", async () => {
    const block = (id: string, minutes: number) =>
      ({
        accessibleLabel: `${id} label`,
        caption: `${id} caption`,
        endMs: at(12) + minutes * MINUTE_MS,
        id,
        kind: "mixed",
        startMs: at(12),
        title: `${id} title`,
        tone: { type: "neutral" },
      }) as const;
    // At the 15-minute grid a slot is 22 px: 10 minutes is under one line.
    const tooShort = block("brief", 10);
    const oneLine = {
      ...block("line", 15),
      startMs: at(13),
      endMs: at(13, 15),
    };
    const { cleanup, container } = await renderCalendar({
      columns: [{ ...activityColumn, blocks: [tooShort, oneLine] }],
    });
    const surface = (label: string) =>
      container.querySelector<HTMLElement>(`[aria-label="${label}"]`);

    expect(surface("brief label")?.textContent).toBe("");
    expect(surface("line label")?.textContent).toBe("line titleline caption");
    await cleanup();
  });

  test("a column without range selection takes no focus and ignores drags", async () => {
    const { cleanup, container, selected } = await renderCalendar();
    const surface = surfaceOf(container, "entries");

    await pointer(surface, "pointerdown", pixelsAt(60, 15));
    await pointer(surface, "pointerup", pixelsAt(120, 15));

    expect(surface.hasAttribute("tabindex")).toBe(false);
    expect(selected).toEqual([]);
    await cleanup();
  });

  test("a suggestion is a dashed button that acts without starting a range selection", async () => {
    const activated: string[] = [];
    const { cleanup, container, selected } = await renderCalendar({
      columns: [
        activityColumn,
        {
          ...entriesColumn,
          blocks: [
            ...entriesColumn.blocks,
            {
              accessibleLabel: "Suggested: Service agreement, 1.0 h",
              endMs: at(9, 5),
              id: "suggestion-service-agreement",
              kind: "entry",
              onActivate: () => {
                activated.push("suggestion-service-agreement");
              },
              startMs: at(8, 5),
              state: "suggestion",
              title: "Service agreement",
              tone: { type: "neutral" },
            },
          ],
          rangeSelection: { label: "Select a range", type: "enabled" },
        },
      ],
    });
    const suggestion = container.querySelector<HTMLButtonElement>(
      '[data-block-id="suggestion-service-agreement"]',
    );
    const draft = container.querySelector<HTMLElement>(
      '[data-block-id="entry-lease"]',
    );
    expect(suggestion?.tagName).toBe("BUTTON");
    expect(suggestion?.dataset["state"]).toBe("suggestion");
    expect(suggestion?.className).toContain("border-dashed");
    expect(draft?.tagName).toBe("ARTICLE");
    expect(draft?.dataset["state"]).toBe("draft");
    if (suggestion === null) {
      throw new Error("The suggestion did not render");
    }
    surfaceOf(container, "entries");
    await pointer(suggestion, "pointerdown", pixelsAt(10, 15));
    await pointer(suggestion, "pointerup", pixelsAt(10, 15));
    await act(async () => suggestion.click());

    expect(activated).toEqual(["suggestion-service-agreement"]);
    expect(selected).toEqual([]);
    expect(
      container.querySelector('[data-slot="day-calendar-selection"]'),
    ).toBeNull();
    await cleanup();
  });

  test("a committed selection anchors the caller's panel in another column", async () => {
    const { cleanup, container } = await renderCalendar({
      selection: {
        columnId: "activity",
        panel: {
          columnId: "entries",
          content: <form aria-label="New entry" />,
        },
        range: { endMs: at(10, 45), startMs: at(9, 30) },
      },
    });

    const panel = container.querySelector<HTMLElement>(
      '[data-column-id="entries"] [data-slot="day-calendar-panel"]',
    );
    expect(panel?.querySelector('form[aria-label="New entry"]')).not.toBeNull();
    expect(panel?.style.insetBlockStart).toBe(`${String(pixelsAt(90, 15))}px`);
    expect(
      container.querySelector<HTMLElement>(
        '[data-column-id="activity"] [data-slot="day-calendar-selection"]',
      )?.dataset["state"],
    ).toBe("committed");
    await cleanup();
  });

  test("a locked column renders none of the caller's blocks", async () => {
    const lockedColumn = {
      action: <button type="button">Show activity</button>,
      id: "activity",
      label: "Activity",
      type: "locked",
    } as const satisfies DayCalendarColumn;
    const { cleanup, container } = await renderCalendar({
      columns: [lockedColumn, entriesColumn],
    });
    const locked = container.querySelector<HTMLElement>(
      '[data-column-id="activity"]',
    );

    expect(locked?.dataset["type"]).toBe("locked");
    expect(
      locked?.querySelector('[data-slot="day-calendar-block"]'),
    ).toBeNull();
    expect(
      locked?.querySelector('[data-slot="day-calendar-surface"]'),
    ).toBeNull();
    expect(locked?.textContent).toBe("Show activity");
    const placeholder = locked?.querySelector(
      '[data-slot="day-calendar-locked-placeholder"]',
    );
    expect(placeholder?.getAttribute("aria-hidden")).toBe("true");
    expect(placeholder?.hasAttribute("inert")).toBe(true);
    // The unlocked column still renders its own blocks.
    expect(
      container.querySelectorAll('[data-slot="day-calendar-block"]'),
    ).toHaveLength(entriesColumn.blocks.length);
    await cleanup();
  });

  test("a coarser granularity shrinks the grid and snaps drags to it", async () => {
    const { cleanup, container, rerender, selected } = await renderCalendar();
    const column = container.querySelector<HTMLElement>(
      '[data-column-id="activity"]',
    );
    const dayMinutes = (HOURS.endHour - HOURS.startHour) * 60;
    expect(column?.style.blockSize).toBe(
      `${String(pixelsAt(dayMinutes, 15))}px`,
    );

    await rerender({ granularity: 60 });
    expect(column?.style.blockSize).toBe(
      `${String(pixelsAt(dayMinutes, 60))}px`,
    );

    const surface = surfaceOf(container, "activity");
    await pointer(surface, "pointerdown", pixelsAt(97, 60));
    await pointer(surface, "pointerup", pixelsAt(161, 60));

    expect(selected).toEqual([
      { columnId: "activity", range: { endMs: at(11), startMs: at(9) } },
    ]);
    await cleanup();
  });

  test("labels hours in the locale's clock and shows the now-line only today", async () => {
    const { cleanup, container, rerender } = await renderCalendar({
      locale: "en-US",
    });
    const firstHour = container.querySelector(
      '[data-slot="day-calendar-hour"]',
    );

    expect(firstHour?.textContent).toBe("8:00 AM");
    expect(
      container.querySelectorAll('[data-slot="day-calendar-now"]'),
    ).toHaveLength(2);

    await rerender({ locale: "cs-CZ", nowMs: at(8) - 24 * 60 * MINUTE_MS });
    expect(
      container.querySelector('[data-slot="day-calendar-hour"]')?.textContent,
    ).toBe("8:00");
    expect(
      container.querySelector('[data-slot="day-calendar-now"]'),
    ).toBeNull();
    await cleanup();
  });
});
