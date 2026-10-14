import {
  isAgendaListItemType,
  type ListItemType,
} from "@stll/api-contract/entity-options";
import { compareCodeUnit } from "@stll/collation";

type AgendaCandidate = {
  kind: string;
  listItemType: ListItemType | null;
  status: string | null;
  dueDate: string | null;
};

/**
 * The matter's upcoming agenda: open tasks, never reference list items such as
 * facts, and never a due date before `today` (an ISO date). Dated items come
 * first, nearest deadline first; undated open tasks follow.
 */
export const selectUpcomingAgenda = <T extends AgendaCandidate>(
  entities: readonly T[],
  today: string,
): T[] =>
  entities
    .filter(
      (entity) =>
        entity.kind === "task" &&
        isAgendaListItemType(entity.listItemType) &&
        entity.status !== "done" &&
        entity.status !== "cancelled" &&
        (entity.dueDate === null || entity.dueDate >= today),
    )
    .toSorted((a, b) => {
      if (a.dueDate === null || b.dueDate === null) {
        return Number(a.dueDate === null) - Number(b.dueDate === null);
      }
      return compareCodeUnit(a.dueDate, b.dueDate);
    });
