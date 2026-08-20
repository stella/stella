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
    expect(markup).toContain("grid-column:2 / span 2");
    expect(markup).toContain("<article");
    expect(markup).not.toContain("disabled");
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
