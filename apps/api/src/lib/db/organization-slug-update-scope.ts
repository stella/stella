import { AsyncLocalStorage } from "node:async_hooks";

type SlugUpdate = { organizationId: string; userId: string; slug: string };
let scope: AsyncLocalStorage<SlugUpdate> | undefined;
const getScope = () => (scope ??= new AsyncLocalStorage<SlugUpdate>());

/** Only the audited operation may send a slug through Better Auth's update endpoint. */
export const runWithOrganizationSlugUpdate = <T>(
  update: SlugUpdate,
  run: () => T,
): T => getScope().run(update, run);

export const isOrganizationSlugUpdate = (update: SlugUpdate): boolean => {
  const current = getScope().getStore();
  return (
    current !== undefined &&
    current.organizationId === update.organizationId &&
    current.userId === update.userId &&
    current.slug === update.slug
  );
};
