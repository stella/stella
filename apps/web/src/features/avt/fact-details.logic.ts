import type {
  FactDetails,
  FactDetailsBody,
  ListItem,
} from "@/features/avt/types";

/** The facts of a list: its items typed as facts, in list order. */
export const factItems = (items: readonly ListItem[]): ListItem[] =>
  items.filter((item) => item.itemType === "fact");

/**
 * Facts held out of scoring first: they are the ones waiting on a reviewer.
 * Stable otherwise, so the list keeps its own order.
 */
export const orderHeldFirst = <T extends Pick<ListItem, "factDetails">>(
  facts: readonly T[],
): T[] =>
  facts.toSorted(
    (a, b) =>
      Number(b.factDetails?.scoring === "held") -
      Number(a.factDetails?.scoring === "held"),
  );

type FactDetailsBodyArgs = {
  listId: FactDetailsBody["listId"];
  itemEntityId: FactDetailsBody["itemEntityId"];
  details: FactDetails;
};

/**
 * The PUT body that stores `details` as the fact's whole detail. The endpoint
 * replaces every field, so each edit sends the full detail with one field
 * changed.
 */
export const toFactDetailsBody = ({
  listId,
  itemEntityId,
  details,
}: FactDetailsBodyArgs): FactDetailsBody => ({
  listId,
  itemEntityId,
  occurredOn:
    details.occurredOn === null || details.occurredOnPrecision === null
      ? null
      : { date: details.occurredOn, precision: details.occurredOnPrecision },
  evidenceKind: details.evidenceKind,
  medium: details.medium,
  confidence: details.confidence,
  interpretationNote: details.interpretationNote,
  scoring: details.scoring,
});

type ItemsPage = { items: Pick<ListItem, "id" | "factDetails">[] };

/** Pages of a list's items with one fact's detail replaced. */
export const withFactDetails = <P extends ItemsPage>(
  pages: readonly P[],
  itemEntityId: ListItem["id"],
  details: FactDetails | null,
): P[] =>
  pages.map((page) => ({
    ...page,
    items: page.items.map((item) =>
      item.id === itemEntityId ? { ...item, factDetails: details } : item,
    ),
  }));
