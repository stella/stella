/**
 * The components resolveDatabaseUrl() requires when it assembles a URL. DB_SSLMODE is
 * absent on purpose: it defaults to `require` when unset.
 */
export const DATABASE_COMPONENT_KEYS = [
  "DB_HOST",
  "DB_PORT",
  "DB_USER",
  "DB_PASSWORD",
  "DB_NAME",
] as const;
