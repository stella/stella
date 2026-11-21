/** Every member's saved inbox views, by organization and member. */
export const entityViewLayoutsRoot = () => ["entity-view-layouts"] as const;

/** One member's saved inbox views in one organization. */
export const entityViewLayoutsKey = (organizationId: string, userId: string) =>
  [...entityViewLayoutsRoot(), organizationId, userId] as const;
