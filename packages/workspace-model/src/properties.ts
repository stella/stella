export const workspacePropertyDefinitionStatuses = [
  "active",
  "archived",
] as const;

export type WorkspacePropertyDefinitionStatus =
  (typeof workspacePropertyDefinitionStatuses)[number];

export const workspacePropertyTypes = [
  "file",
  "text",
  "single-select",
  "multi-select",
  "date",
  "int",
  "money",
  "person",
] as const;

export type WorkspacePropertyType = (typeof workspacePropertyTypes)[number];

export type WorkspaceIdentifier = string | number;
export type WorkspacePropertyIdentifier = WorkspaceIdentifier;

/**
 * A named group of a select property's options ("To do", "In progress",
 * "Done"). Groups are presentation and rules over the options: a board shows
 * a group's options as columns under one band and can fold the band; the
 * stored value still references an option, never a group.
 */
export type WorkspacePropertyOptionGroup<
  GroupId extends WorkspacePropertyIdentifier = WorkspacePropertyIdentifier,
  Color extends string = string,
> = {
  color?: Color | undefined;
  id: GroupId;
  key: string;
  label: string;
  sortOrder: number;
};

export type WorkspacePropertyOption<
  OptionId extends WorkspacePropertyIdentifier = WorkspacePropertyIdentifier,
  Color extends string = string,
  GroupId extends WorkspacePropertyIdentifier = WorkspacePropertyIdentifier,
> = {
  color: Color;
  /** The declared group this option belongs to, when the definition groups. */
  groupId?: GroupId | undefined;
  id: OptionId;
  key: string;
  label: string;
  sortOrder: number;
  status: WorkspacePropertyDefinitionStatus;
};

type WorkspacePropertyDefinitionBase<
  PropertyId extends WorkspacePropertyIdentifier,
> = {
  id: PropertyId;
  key: string;
  label: string;
  revision: number;
  status: WorkspacePropertyDefinitionStatus;
};

type WorkspaceSelectPropertyDefinition<
  PropertyId extends WorkspacePropertyIdentifier,
  OptionId extends WorkspacePropertyIdentifier,
  Color extends string,
> = WorkspacePropertyDefinitionBase<PropertyId> & {
  fallbackOptionId: OptionId | null;
  /**
   * Declared option groups, in band order. Only a single select groups: a
   * multi-select value has no single column to sit under a band.
   */
  groups?: readonly WorkspacePropertyOptionGroup<OptionId, Color>[] | undefined;
  options: readonly WorkspacePropertyOption<OptionId, Color, OptionId>[];
  type: "multi-select" | "single-select";
};

/**
 * Host-neutral property definition. Stable identifiers, rather than labels,
 * are the persisted relationship between definitions, options, and values.
 */
export type WorkspacePropertyDefinition<
  PropertyId extends WorkspacePropertyIdentifier = WorkspacePropertyIdentifier,
  OptionId extends WorkspacePropertyIdentifier = WorkspacePropertyIdentifier,
  Color extends string = string,
> =
  | (WorkspacePropertyDefinitionBase<PropertyId> & {
      type: "file" | "text" | "date" | "int" | "person";
    })
  | (WorkspacePropertyDefinitionBase<PropertyId> & {
      currency: string | null;
      type: "money";
    })
  | WorkspaceSelectPropertyDefinition<PropertyId, OptionId, Color>;

export type WorkspaceFileValue = {
  encrypted: boolean;
  fileName: string;
  id: string;
  mimeType: string;
  pdfFileId: string | null;
  sha256Hex: string;
  sizeBytes: number;
};

type WorkspacePropertyValueBase<
  PropertyId extends WorkspacePropertyIdentifier,
> = {
  propertyId: PropertyId;
};

/**
 * Persisted property value. The discriminator carries the cardinality rule:
 * a single select can reference at most one option, while a multi-select owns
 * an explicit list.
 */
export type WorkspacePropertyValue<
  PropertyId extends WorkspacePropertyIdentifier = WorkspacePropertyIdentifier,
  OptionId extends WorkspacePropertyIdentifier = WorkspacePropertyIdentifier,
> =
  | (WorkspacePropertyValueBase<PropertyId> & {
      type: "file";
      value: WorkspaceFileValue;
    })
  | (WorkspacePropertyValueBase<PropertyId> & {
      type: "text";
      value: string;
    })
  | (WorkspacePropertyValueBase<PropertyId> & {
      optionId: OptionId | null;
      type: "single-select";
    })
  | (WorkspacePropertyValueBase<PropertyId> & {
      optionIds: readonly OptionId[];
      type: "multi-select";
    })
  | (WorkspacePropertyValueBase<PropertyId> & {
      type: "date";
      value: string | null;
    })
  | (WorkspacePropertyValueBase<PropertyId> & {
      type: "int";
      value: number;
    })
  | (WorkspacePropertyValueBase<PropertyId> & {
      amountCents: number;
      currency: string;
      type: "money";
    })
  | (WorkspacePropertyValueBase<PropertyId> & {
      image: string | null;
      name: string;
      type: "person";
      userId: string | null;
    });

const workspacePropertyTypeSet: ReadonlySet<string> = new Set(
  workspacePropertyTypes,
);

export const isWorkspacePropertyType = (
  value: string,
): value is WorkspacePropertyType => workspacePropertyTypeSet.has(value);

/** A declared group with the options that belong to it, in option order. */
export type WorkspacePropertyOptionGroupSpan<
  OptionId extends WorkspacePropertyIdentifier = WorkspacePropertyIdentifier,
  Color extends string = string,
> = {
  group: WorkspacePropertyOptionGroup<OptionId, Color> | null;
  options: WorkspacePropertyOption<OptionId, Color, OptionId>[];
};

export type WorkspacePropertyOptionGroupIssue =
  | { groupId: WorkspacePropertyIdentifier; type: "undeclared-group" }
  | { groupId: WorkspacePropertyIdentifier; type: "split-group" };

export type ResolvedWorkspacePropertyOptionGroups<
  OptionId extends WorkspacePropertyIdentifier = WorkspacePropertyIdentifier,
  Color extends string = string,
> =
  | { spans: WorkspacePropertyOptionGroupSpan<OptionId, Color>[]; type: "ok" }
  | { issues: WorkspacePropertyOptionGroupIssue[]; type: "invalid" };

/**
 * Lay a select property's options out by group, in `sortOrder`.
 *
 * Two rules make a grouped definition renderable as bands: every `groupId`
 * names a declared group, and a group's options are adjacent once sorted, so
 * one band can span them. A definition that breaks either is reported, not
 * repaired: silently drawing two bands for one group would misstate the
 * host's data. Ungrouped options form runs of their own with `group: null`.
 */
export const resolveWorkspacePropertyOptionGroups = <
  OptionId extends WorkspacePropertyIdentifier,
  Color extends string,
>({
  groups = [],
  options,
}: {
  groups?: readonly WorkspacePropertyOptionGroup<OptionId, Color>[] | undefined;
  options: readonly WorkspacePropertyOption<OptionId, Color, OptionId>[];
}): ResolvedWorkspacePropertyOptionGroups<OptionId, Color> => {
  const groupsById = new Map(groups.map((group) => [group.id, group] as const));
  const issues: WorkspacePropertyOptionGroupIssue[] = [];
  const spans: WorkspacePropertyOptionGroupSpan<OptionId, Color>[] = [];
  const closed = new Set<OptionId>();
  const sorted = [...options].sort(
    (left, right) => left.sortOrder - right.sortOrder,
  );

  for (const option of sorted) {
    const groupId = option.groupId;
    const group = groupId === undefined ? null : groupsById.get(groupId);
    if (groupId !== undefined && group === undefined) {
      issues.push({ groupId, type: "undeclared-group" });
      continue;
    }
    const last = spans.at(-1);
    if (group !== null && group !== undefined && last?.group?.id === group.id) {
      last.options.push(option);
      continue;
    }
    if (last?.group !== null && last?.group !== undefined) {
      closed.add(last.group.id);
    }
    if (group !== null && group !== undefined && closed.has(group.id)) {
      issues.push({ groupId: group.id, type: "split-group" });
      continue;
    }
    spans.push({ group: group ?? null, options: [option] });
  }

  return issues.length === 0
    ? { spans, type: "ok" }
    : { issues, type: "invalid" };
};
