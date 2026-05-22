import { panic } from "better-result";

/**
 * Resolve the Postgres connection URL.
 *
 * Accepts either DATABASE_URL or a set of components
 * (DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME, and an optional
 * DB_SSLMODE) that this helper assembles into a URL. Components are
 * useful when the password is sourced from a different place than
 * the rest of the connection metadata.
 */

const COMPONENT_KEYS = [
  "DB_HOST",
  "DB_PORT",
  "DB_USER",
  "DB_PASSWORD",
  "DB_NAME",
] as const;

// Only TLS-enforcing modes are allowed via DB_SSLMODE. `disable`,
// `allow`, and `prefer` would silently downgrade transport security
// and have no legitimate reason to appear in a managed deploy.
const ALLOWED_SSLMODES = ["require", "verify-ca", "verify-full"] as const;

export const resolveDatabaseUrl = (
  env: NodeJS.ProcessEnv = process.env,
): string | undefined => {
  if (env["DATABASE_URL"]) {
    return env["DATABASE_URL"];
  }

  const { DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME, DB_SSLMODE } = env;

  // Password is allowed to be the empty string (valid in some local
  // dev setups), so check it with `undefined` rather than truthiness.
  if (
    !DB_HOST &&
    !DB_PORT &&
    !DB_USER &&
    DB_PASSWORD === undefined &&
    !DB_NAME
  ) {
    return undefined;
  }
  if (
    !DB_HOST ||
    !DB_PORT ||
    !DB_USER ||
    DB_PASSWORD === undefined ||
    !DB_NAME
  ) {
    const missing = COMPONENT_KEYS.filter((k) =>
      k === "DB_PASSWORD" ? env[k] === undefined : !env[k],
    );
    panic(
      `DATABASE_URL not set and DB component env vars incomplete; missing: ${missing.join(", ")}`,
    );
  }

  const sslmode = DB_SSLMODE ?? "require";
  if (!(ALLOWED_SSLMODES as readonly string[]).includes(sslmode)) {
    panic(`DB_SSLMODE must be one of ${ALLOWED_SSLMODES.join(", ")}`);
  }
  // DB_HOST is left unencoded so IPv6 literals like `[::1]` survive,
  // but URL delimiters in it would otherwise be spliced into the
  // path/query and could smuggle `sslmode=disable` or point at a
  // different database. Same idea for DB_PORT, which must be numeric.
  if (/[/?#@\s]/u.test(DB_HOST)) {
    panic("DB_HOST must not contain URL delimiters (/, ?, #, @, whitespace)");
  }
  if (!/^\d+$/u.test(DB_PORT)) {
    panic("DB_PORT must be numeric");
  }
  const auth = `${encodeURIComponent(DB_USER)}:${encodeURIComponent(DB_PASSWORD)}`;
  const name = encodeURIComponent(DB_NAME);
  return `postgres://${auth}@${DB_HOST}:${DB_PORT}/${name}?sslmode=${sslmode}`;
};
