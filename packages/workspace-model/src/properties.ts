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

export type WorkspacePropertyOption<
  OptionId extends WorkspacePropertyIdentifier = WorkspacePropertyIdentifier,
  Color extends string = string,
> = {
  color: Color;
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
  options: readonly WorkspacePropertyOption<OptionId, Color>[];
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
