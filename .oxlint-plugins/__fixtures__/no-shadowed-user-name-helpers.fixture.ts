declare const canonicalDisplayName: (name: string) => string;
declare const canonicalInitials: (name: string) => string;

// A module-level shadow implementation must be rejected.
// oxlint-disable-next-line no-shadowed-user-name-helpers/no-shadowed-user-name-helpers
const getInitials = (name: string) => name.slice(0, 2);

// An exported module-level shadow implementation must also be rejected.
// oxlint-disable-next-line no-shadowed-user-name-helpers/no-shadowed-user-name-helpers
export const getDisplayName = (name: string) => name;

// Imports, differently named helpers, and nested callback bindings are valid.
const initialsForOrganization = (name: string) => name.slice(0, 2);
const render = () => {
  // oxlint-disable-next-line no-shadow
  const getDisplayName = (name: string) => name;
  return getDisplayName("Ada");
};

export const __noShadowedUserNameHelpersFixture = {
  canonicalDisplayName,
  canonicalInitials,
  getDisplayName,
  getInitials,
  initialsForOrganization,
  render,
};
