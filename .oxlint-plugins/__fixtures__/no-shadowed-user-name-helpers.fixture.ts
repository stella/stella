import {
  getDisplayName as canonicalDisplayName,
  getInitials as canonicalInitials,
} from "@/lib/user-name";

// A module-level shadow implementation must be rejected.
// oxlint-disable-next-line no-shadowed-user-name-helpers/no-shadowed-user-name-helpers
const getInitials = (name: string) => name.slice(0, 2);

// Imports, differently named helpers, and nested callback bindings are valid.
const initialsForOrganization = (name: string) => name.slice(0, 2);
const render = () => {
  const getDisplayName = (name: string) => name;
  return getDisplayName("Ada");
};

export const __noShadowedUserNameHelpersFixture = {
  canonicalDisplayName,
  canonicalInitials,
  getInitials,
  initialsForOrganization,
  render,
};
