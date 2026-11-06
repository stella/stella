export type ContextMenuEntity = {
  id: string;
  kind: string;
};

const ENTITY_SELECTOR = "[data-entity-kind][data-entity-id]";
const OWNER_SELECTOR = `[data-context-menu-target], ${ENTITY_SELECTOR}`;

/** Resolves the entity row which owns a context-menu event. */
export const resolveContextMenuTarget = (event: {
  target: unknown;
}): ContextMenuEntity | null => {
  if (!(event.target instanceof Node)) {
    return null;
  }
  const element =
    event.target instanceof Element ? event.target : event.target.parentElement;
  if (!element) {
    return null;
  }

  const owner = element.closest<HTMLElement>(OWNER_SELECTOR);
  const id = owner?.dataset["entityId"];
  const kind = owner?.dataset["entityKind"];
  return id && kind ? { id, kind } : null;
};

export const contextMenuBelongsTo = (
  event: { target: unknown; currentTarget?: unknown },
  entity?: ContextMenuEntity,
): boolean => {
  if (event.currentTarget !== undefined) {
    if (
      !(event.currentTarget instanceof Element) ||
      !(event.target instanceof Node)
    ) {
      return false;
    }
    const element =
      event.target instanceof Element
        ? event.target
        : event.target.parentElement;
    if (
      !event.currentTarget.contains(event.target) ||
      element?.closest(OWNER_SELECTOR) !==
        event.currentTarget.closest(OWNER_SELECTOR)
    ) {
      return false;
    }
  }
  if (entity === undefined) {
    return event.currentTarget instanceof Element;
  }
  const target = resolveContextMenuTarget(event);
  return target?.id === entity.id && target.kind === entity.kind;
};
