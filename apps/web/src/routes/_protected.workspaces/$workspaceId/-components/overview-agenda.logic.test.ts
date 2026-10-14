import { describe, expect, test } from "bun:test";

import {
  LIST_ITEM_TYPE,
  LIST_ITEM_TYPES,
  type ListItemType,
} from "@stll/api-contract/entity-options";

import { selectUpcomingAgenda } from "./overview-agenda.logic";

const TODAY = "2026-10-14";

const entity = (
  name: string,
  overrides: Partial<{
    kind: string;
    listItemType: ListItemType | null;
    status: string | null;
    dueDate: string | null;
  }> = {},
) => ({
  name,
  kind: "task",
  listItemType: null,
  status: "open",
  dueDate: null,
  ...overrides,
});

const names = (entities: readonly { name: string }[]) =>
  entities.map((item) => item.name);

describe("upcoming agenda", () => {
  test.each(LIST_ITEM_TYPES.filter((type) => type !== LIST_ITEM_TYPE.TASK))(
    "leaves out %s list items, dated or not",
    (listItemType) => {
      expect(
        selectUpcomingAgenda(
          [
            entity("reference", { listItemType }),
            entity("dated reference", { listItemType, dueDate: "2026-12-01" }),
          ],
          TODAY,
        ),
      ).toEqual([]);
    },
  );

  test("keeps plain tasks and task list items", () => {
    expect(
      names(
        selectUpcomingAgenda(
          [
            entity("plain"),
            entity("list task", { listItemType: LIST_ITEM_TYPE.TASK }),
          ],
          TODAY,
        ),
      ),
    ).toEqual(["plain", "list task"]);
  });

  test("leaves out past due dates but keeps today", () => {
    expect(
      names(
        selectUpcomingAgenda(
          [
            entity("yesterday", { dueDate: "2026-10-13" }),
            entity("long past", { dueDate: "2021-08-23" }),
            entity("today", { dueDate: TODAY }),
          ],
          TODAY,
        ),
      ),
    ).toEqual(["today"]);
  });

  test.each(["done", "cancelled"])("leaves out %s tasks", (status) => {
    expect(
      selectUpcomingAgenda(
        [entity("closed", { status, dueDate: "2026-12-01" })],
        TODAY,
      ),
    ).toEqual([]);
  });

  test("leaves out other entity kinds", () => {
    expect(
      selectUpcomingAgenda([entity("document", { kind: "document" })], TODAY),
    ).toEqual([]);
  });

  test("orders dated items by nearest deadline, undated last", () => {
    expect(
      names(
        selectUpcomingAgenda(
          [
            entity("undated"),
            entity("later", { dueDate: "2026-11-02" }),
            entity("sooner", { dueDate: "2026-10-20" }),
          ],
          TODAY,
        ),
      ),
    ).toEqual(["sooner", "later", "undated"]);
  });
});
