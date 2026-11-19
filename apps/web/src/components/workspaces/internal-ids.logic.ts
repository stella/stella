/*
 * The ids of a workspace table's own columns, apart from the formatting the
 * rest of `entity-utils` does, so a module that only lays a table out (its
 * schema, a loading view's columns) loads no formatter.
 */

type InternalColId = "select" | "add-property";

export const getInternalColId = (col: InternalColId): InternalColId => col;

// -- Internal property IDs (metadata columns stored in view config) --

type InternalProperty =
  | "name"
  | "created-by"
  | "updated-at"
  | "version"
  | "kind"
  | "list-item-type"
  | "status"
  | "priority"
  | "due-date"
  | "assignee";
export type InternalPropertyId = `_${InternalProperty}`;

export const getInternalPropertyId = (
  p: InternalProperty,
): InternalPropertyId => `_${p}`;
