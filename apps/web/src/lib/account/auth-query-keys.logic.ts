/**
 * The keys of the session's own queries, apart from the reads that fill them,
 * so a module that only looks into the cache (a loading view reading the
 * cached role) does not load the auth client or the query options.
 */
export const rootKeys = {
  session: ["session"],
  role: ["role"],
  activeMember: ["active-organization-member"],
};
