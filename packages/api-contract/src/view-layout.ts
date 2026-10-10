export const VIEW_LAYOUT_TYPES = [
  "overview",
  "table",
  "filesystem",
  "kanban",
  "calendar",
  "timeline",
  "avt",
  "correspondence",
] as const;

export type ViewLayoutType = (typeof VIEW_LAYOUT_TYPES)[number];

// `provisioning`: whether a matter must always keep a view of the layout.
// `creation`: whether the "+" menu offers it directly or only a template does.
// `perMatter`: whether a matter may hold several views of the layout or at
// most one (a layout that shows the whole matter rather than a filtered slice).
const VIEW_LAYOUT_POLICY = {
  overview: { provisioning: "required", creation: "direct", perMatter: "one" },
  table: { provisioning: "required", creation: "direct", perMatter: "many" },
  filesystem: {
    provisioning: "required",
    creation: "direct",
    perMatter: "many",
  },
  kanban: { provisioning: "required", creation: "direct", perMatter: "many" },
  calendar: {
    provisioning: "optional",
    creation: "direct",
    perMatter: "many",
  },
  timeline: {
    provisioning: "optional",
    creation: "template-only",
    perMatter: "many",
  },
  avt: {
    provisioning: "optional",
    creation: "template-only",
    perMatter: "many",
  },
  // The matter's inbound mail. New matters get one, but it can be removed and
  // added back from the "+" menu.
  correspondence: {
    provisioning: "optional",
    creation: "direct",
    perMatter: "one",
  },
} as const satisfies Record<
  ViewLayoutType,
  {
    provisioning: "optional" | "required";
    creation: "direct" | "template-only";
    perMatter: "one" | "many";
  }
>;

export type RequiredViewLayoutType = {
  [
    TType in ViewLayoutType
  ]: (typeof VIEW_LAYOUT_POLICY)[TType]["provisioning"] extends "required"
    ? TType
    : never;
}[ViewLayoutType];

export type DirectlyCreatableViewLayoutType = {
  [
    TType in ViewLayoutType
  ]: (typeof VIEW_LAYOUT_POLICY)[TType]["creation"] extends "direct"
    ? TType
    : never;
}[ViewLayoutType];

export type SingleViewLayoutType = {
  [
    TType in ViewLayoutType
  ]: (typeof VIEW_LAYOUT_POLICY)[TType]["perMatter"] extends "one"
    ? TType
    : never;
}[ViewLayoutType];

export const isRequiredViewLayout = (
  type: ViewLayoutType,
): type is RequiredViewLayoutType =>
  VIEW_LAYOUT_POLICY[type].provisioning === "required";

const isDirectlyCreatableViewLayout = (
  type: ViewLayoutType,
): type is DirectlyCreatableViewLayoutType =>
  VIEW_LAYOUT_POLICY[type].creation === "direct";

/**
 * A layout a matter holds at most one view of (overview, correspondence):
 * creating, duplicating or converting into a second one is refused.
 */
export const isSingleViewLayout = (
  type: ViewLayoutType,
): type is SingleViewLayoutType => VIEW_LAYOUT_POLICY[type].perMatter === "one";

export type ConvertibleViewLayoutType = Exclude<
  ViewLayoutType,
  SingleViewLayoutType
>;

const isConvertibleViewLayout = (
  type: ViewLayoutType,
): type is ConvertibleViewLayoutType => !isSingleViewLayout(type);

// Non-empty by construction so it can back a schema enum.
export const CONVERTIBLE_VIEW_LAYOUTS: readonly [
  ConvertibleViewLayoutType,
  ...ConvertibleViewLayoutType[],
] = [
  "table",
  ...VIEW_LAYOUT_TYPES.filter(isConvertibleViewLayout).filter(
    (type) => type !== "table",
  ),
];

export const REQUIRED_VIEW_LAYOUTS =
  VIEW_LAYOUT_TYPES.filter(isRequiredViewLayout);

export const DIRECTLY_CREATABLE_VIEW_LAYOUTS = VIEW_LAYOUT_TYPES.filter(
  isDirectlyCreatableViewLayout,
);

/** Retains list identity for reconciliation without disclosing layout details. */
export type UnavailableWorkspaceView = {
  id: string;
  eligibility: "unavailable";
};
