import type * as React from "react";

export type ContextMenuEntity = {
  id: string;
  kind: string;
};

const ENTITY_SELECTOR = "[data-entity-kind][data-entity-id]";

/** Resolves the entity row which owns a context-menu event. */
export const resolveContextMenuTarget = (
  event: Pick<React.MouseEvent, "target">,
): ContextMenuEntity | null => {
  if (!(event.target instanceof Element)) {
    return null;
  }

  const element = event.target.closest<HTMLElement>(ENTITY_SELECTOR);
  const id = element?.dataset["entityId"];
  const kind = element?.dataset["entityKind"];
  return id && kind ? { id, kind } : null;
};

export const contextMenuBelongsTo = (
  event: Pick<React.MouseEvent, "target">,
  entity: ContextMenuEntity,
): boolean => {
  const target = resolveContextMenuTarget(event);
  return target?.id === entity.id && target.kind === entity.kind;
};
