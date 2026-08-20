import { renderToStaticMarkup } from "react-dom/server";

import { describe, expect, test } from "bun:test";

import { ResourceCalendar } from "./resource-calendar";

const columns = [
  { date: "2026-08-01", label: "Saturday" },
  { date: "2026-08-02", label: "Sunday" },
] as const;
const resources = [{ id: "room-a", label: "Room A" }] as const;

describe("ResourceCalendar", () => {
  test("renders a complete read-only resource row and clips its entry", () => {
    const markup = renderToStaticMarkup(
      <ResourceCalendar
        ariaLabel="Room schedule"
        columns={columns}
        entries={[
          {
            accessibleLabel: "Hearing in Room A",
            endDateExclusive: "2026-08-03",
            id: "hearing-1",
            label: "Hearing",
            resourceId: "room-a",
            startDate: "2026-07-31",
          },
        ]}
        resourceHeader="Room"
        resources={resources}
      />,
    );

    expect(markup).toContain('aria-label="Room schedule"');
    expect(markup).toContain("Room A");
    expect(markup).toContain("Hearing");
    expect(markup).toContain("inline-size:calc(2 * 100%)");
    expect(markup).toContain("min-width:28rem");
    expect(markup).toContain("sticky start-0 z-20");
    expect(markup).toContain('role="table"');
    expect(markup).toContain('role="columnheader"');
    expect(markup).toContain('role="rowheader"');
    expect(markup).toContain('role="gridcell"');
    expect(markup.match(/role="gridcell"/gu)).toHaveLength(columns.length);
    expect(markup).toContain("aria-describedby");
    expect(markup).toContain("<article");
    expect(markup).not.toContain("disabled");
  });

  test("renders selectable entries as non-submitting keyboard controls", () => {
    const markup = renderToStaticMarkup(
      <ResourceCalendar
        ariaLabel="Room schedule"
        columns={columns}
        entries={[
          {
            accessibleLabel: "Hearing in Room A",
            endDateExclusive: "2026-08-02",
            id: "hearing-1",
            label: "Hearing",
            resourceId: "room-a",
            startDate: "2026-08-01",
          },
        ]}
        onSelectEntry={() => undefined}
        resourceHeader="Room"
        resources={resources}
      />,
    );

    expect(markup).toContain("<button");
    expect(markup).toContain('aria-label="Hearing in Room A"');
    expect(markup).toContain('type="button"');
    expect(markup).toContain("min-height:5rem");
    expect(markup).toContain("focus-visible:ring-2");
  });

  test("grows collision lanes without adding logical table cells", () => {
    const markup = renderToStaticMarkup(
      <ResourceCalendar
        ariaLabel="Room schedule"
        columns={columns}
        entries={[
          {
            accessibleLabel: "First hearing in Room A",
            endDateExclusive: "2026-08-02",
            id: "hearing-1",
            label: "First hearing",
            resourceId: "room-a",
            startDate: "2026-08-01",
            tone: "warning",
          },
          {
            accessibleLabel: "Second hearing in Room A",
            endDateExclusive: "2026-08-02",
            id: "hearing-2",
            label: "Second hearing",
            resourceId: "room-a",
            startDate: "2026-08-01",
            tone: "destructive",
          },
        ]}
        onSelectEntry={() => undefined}
        resourceHeader="Room"
        resources={resources}
      />,
    );

    expect(markup).toContain("min-height:7.5rem");
    expect(markup.match(/block-size:50%/gu)).toHaveLength(2);
    expect(markup.match(/role="gridcell"/gu)).toHaveLength(columns.length);
    expect(markup.match(/<button/gu)).toHaveLength(2);
    expect(markup).toContain("bg-warning/15 text-warning-foreground");
    expect(markup).toContain("bg-destructive/12 text-destructive");
  });

  test("rejects entries whose resource is absent", () => {
    expect(() =>
      renderToStaticMarkup(
        <ResourceCalendar
          ariaLabel="Room schedule"
          columns={columns}
          entries={[
            {
              accessibleLabel: "Orphan hearing",
              endDateExclusive: "2026-08-02",
              id: "hearing-1",
              label: "Hearing",
              resourceId: "missing-room",
              startDate: "2026-08-01",
            },
          ]}
          resourceHeader="Room"
          resources={resources}
        />,
      ),
    ).toThrow(
      "Resource calendar entry hearing-1 references an unknown resource",
    );
  });
});
