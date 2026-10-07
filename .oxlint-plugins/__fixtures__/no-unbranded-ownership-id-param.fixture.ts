// Passive regression fixture for
// `no-unbranded-ownership-id-param/no-unbranded-ownership-id-param`.

import { createSafeHandler } from "@/api/lib/api-handlers";

type SafeId<Kind extends string> = string & { readonly __kind: Kind };
type OrganizationInput = { organizationId: string };
type OrganizationLoader = (input: OrganizationInput) => string;

// oxlint-disable-next-line no-unbranded-ownership-id-param/no-unbranded-ownership-id-param -- fixture proves bare identifier parameters require ownership brands
function loadWorkspace(workspaceId: string): string {
  return workspaceId;
}

// oxlint-disable-next-line no-unbranded-ownership-id-param/no-unbranded-ownership-id-param -- fixture proves unannotated destructuring cannot infer an ownership ID safely
const loadOrganization: OrganizationLoader = ({ organizationId }) =>
  organizationId;

// oxlint-disable-next-line no-unbranded-ownership-id-param/no-unbranded-ownership-id-param -- fixture proves inline object annotations cannot contain bare ownership strings
const loadUser = ({ userId }: { userId: string }) => userId;

// oxlint-disable-next-line no-unbranded-ownership-id-param/no-unbranded-ownership-id-param -- fixture proves function-type parameters receive the same guard
type UnsafeLoader = (userId: string) => Promise<void>;

// expect-clean: no-unbranded-ownership-id-param/no-unbranded-ownership-id-param
const loadBrandedWorkspace = (workspaceId: SafeId<"workspace">) => workspaceId;
const unrelatedString = (search: string) => search;

const contextHandler = createSafeHandler({}, ({ workspaceId }) => workspaceId);

export {
  contextHandler,
  loadBrandedWorkspace,
  loadOrganization,
  loadUser,
  loadWorkspace,
  unrelatedString,
};
export type { UnsafeLoader };
