// Passive regression fixture for
// `no-unbranded-ownership-id-param/no-unbranded-ownership-id-param`.

type SafeId<Kind extends string> = string & { readonly __kind: Kind };

// oxlint-disable-next-line no-unbranded-ownership-id-param/no-unbranded-ownership-id-param -- fixture proves bare identifier parameters require ownership brands
function loadWorkspace(workspaceId: string): string {
  return workspaceId;
}

// oxlint-disable-next-line no-unbranded-ownership-id-param/no-unbranded-ownership-id-param -- fixture proves unannotated destructuring cannot infer an ownership ID safely
const loadOrganization = ({ organizationId }) => organizationId;

// oxlint-disable-next-line no-unbranded-ownership-id-param/no-unbranded-ownership-id-param -- fixture proves inline object annotations cannot contain bare ownership strings
const loadUser = ({ userId }: { userId: string }) => userId;

// oxlint-disable-next-line no-unbranded-ownership-id-param/no-unbranded-ownership-id-param -- fixture proves function-type parameters receive the same guard
type UnsafeLoader = (userId: string) => Promise<void>;

const loadBrandedWorkspace = (workspaceId: SafeId<"workspace">) => workspaceId;
const unrelatedString = (search: string) => search;

declare const createSafeHandler: (
  handler: (context: { workspaceId: SafeId<"workspace"> }) => unknown,
) => unknown;
const contextHandler = createSafeHandler(({ workspaceId }) => workspaceId);

export {
  contextHandler,
  loadBrandedWorkspace,
  loadOrganization,
  loadUser,
  loadWorkspace,
  unrelatedString,
};
export type { UnsafeLoader };
