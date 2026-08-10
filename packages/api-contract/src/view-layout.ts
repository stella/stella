export const VIEW_LAYOUT_TYPES = [
  "overview",
  "table",
  "filesystem",
  "kanban",
  "calendar",
  "timeline",
] as const;

export type ViewLayoutType = (typeof VIEW_LAYOUT_TYPES)[number];

const VIEW_LAYOUT_POLICY = {
  overview: { provisioning: "required", creation: "direct" },
  table: { provisioning: "required", creation: "direct" },
  filesystem: { provisioning: "required", creation: "direct" },
  kanban: { provisioning: "required", creation: "direct" },
  calendar: { provisioning: "optional", creation: "direct" },
  timeline: { provisioning: "optional", creation: "template-only" },
} as const satisfies Record<
  ViewLayoutType,
  {
    provisioning: "optional" | "required";
    creation: "direct" | "template-only";
  }
>;

export type RequiredViewLayoutType = {
  [TType in ViewLayoutType]: (typeof VIEW_LAYOUT_POLICY)[TType]["provisioning"] extends "required"
    ? TType
    : never;
}[ViewLayoutType];

export type DirectlyCreatableViewLayoutType = {
  [TType in ViewLayoutType]: (typeof VIEW_LAYOUT_POLICY)[TType]["creation"] extends "direct"
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

export const REQUIRED_VIEW_LAYOUTS =
  VIEW_LAYOUT_TYPES.filter(isRequiredViewLayout);

export const DIRECTLY_CREATABLE_VIEW_LAYOUTS = VIEW_LAYOUT_TYPES.filter(
  isDirectlyCreatableViewLayout,
);
