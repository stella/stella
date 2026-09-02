import { renderToStaticMarkup } from "react-dom/server";

import { describe, expect, test } from "bun:test";
import { IntlProvider } from "use-intl";

import { FormattingProvider } from "@/i18n/formatting-context";
import messages from "@/i18n/langs/en.json";
import { toSafeId } from "@/lib/safe-id";
import type { WorkspaceEntity } from "@/lib/types";
import type { KanbanCalculations } from "@/routes/_protected.workspaces/$workspaceId/-components/kanban/kanban-column";
import { ColumnCalculations } from "@/routes/_protected.workspaces/$workspaceId/-components/kanban/kanban-column";

const FEE = toSafeId<"property">("fee");

const entity = (value: number): WorkspaceEntity => {
  const entityId = toSafeId<"entity">(`entity-${value}`);

  return {
    entityId,
    kind: "document",
    name: `entity-${value}`,
    parentId: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    createdBy: null,
    createdByUserId: null,
    createdByImage: null,
    createdByDeletedAt: null,
    updatedAt: null,
    version: 1,
    status: null,
    priority: null,
    listItemType: "task",
    dueDate: null,
    agendaKind: "task",
    startAt: null,
    endAt: null,
    occurredAt: null,
    remindAt: null,
    allDay: false,
    timeZone: null,
    location: null,
    onlineMeetingUrl: null,
    availability: null,
    sensitivity: null,
    organizer: null,
    attendees: null,
    recurrence: null,
    agendaSource: "manual",
    externalSource: null,
    externalId: null,
    externalChangeKey: null,
    externalICalUid: null,
    readOnly: false,
    sortOrder: null,
    activeEditBy: null,
    cellMetadata: {},
    assignees: [],
    fields: {
      [FEE]: {
        entityId,
        id: toSafeId<"field">(`field-${value}`),
        propertyId: FEE,
        content: { version: 1, type: "int", value, currency: null },
      },
    },
  };
};

const render = (calculations: KanbanCalculations) =>
  renderToStaticMarkup(
    <IntlProvider locale="en" messages={messages} timeZone="UTC">
      <FormattingProvider locale="en" timeZone="UTC">
        <ColumnCalculations
          calculations={calculations}
          entities={[entity(10), entity(5)]}
        />
      </FormattingProvider>
    </IntlProvider>,
  );

const SELECTIONS = [{ propertyId: FEE, kind: "sum" as const }];
const PROPERTIES = [{ id: FEE, name: "Fee", kinds: ["sum"] as const }];

describe("column calculations", () => {
  test("a reader who may not edit the view still sees what the column totals", () => {
    const html = render({ selections: SELECTIONS, properties: PROPERTIES });

    expect(html).toContain("15");
    expect(html).not.toContain(messages.workspaces.calculations.choose);
  });

  test("a reader who may edit gets the picker as well", () => {
    const html = render({
      selections: SELECTIONS,
      properties: PROPERTIES,
      onChange: () => undefined,
    });

    expect(html).toContain("15");
    expect(html).toContain(messages.workspaces.calculations.choose);
  });

  test("an editable view with no calculable properties has no empty picker", () => {
    const html = render({
      selections: [],
      properties: [],
      onChange: () => undefined,
    });

    expect(html).not.toContain(messages.workspaces.calculations.choose);
  });
});
