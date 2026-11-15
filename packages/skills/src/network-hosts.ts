/**
 * Frontmatter `metadata` key under which a skill names the hosts its scripts
 * reach, separated by whitespace like `stella-required-tools`
 * (`stella-network-hosts: aviationweather.gov www.ogimet.com`). A local run
 * lets a sandboxed command reach the hosts the run's skills declare without
 * asking and asks about any other host, so a skill that declares nothing
 * reaches nothing unasked.
 *
 * Names are exact: a subdomain is its own host and is listed on its own, and
 * there are no wildcards, so what a person sees declared is all a skill gets.
 */
export const SKILL_NETWORK_HOSTS_METADATA_KEY = "stella-network-hosts";

/** How many hosts one skill may declare. */
export const SKILL_NETWORK_HOSTS_MAX = 32;

/** A DNS host name in lowercase: labels of letters, digits and inner hyphens. */
const HOST_NAME_PATTERN =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/u;

/**
 * The hosts a skill declares, deduplicated, in declared order. Empty when the
 * key is absent; `null` when any entry is not a lowercase host name (a URL, a
 * port, a wildcard, an IP address), so a mistyped declaration grants nothing
 * instead of part of what was meant.
 */
export const readSkillNetworkHosts = (
  metadata: Readonly<Record<string, string>> | null | undefined,
): readonly string[] | null => {
  const value = metadata?.[SKILL_NETWORK_HOSTS_METADATA_KEY];
  if (value === undefined) {
    return [];
  }
  const hosts = [
    ...new Set(value.split(/\s+/u).filter((host) => host.length > 0)),
  ];
  return hosts.every((host) => HOST_NAME_PATTERN.test(host)) ? hosts : null;
};

/**
 * The host a network request names, in the form declarations use: lowercase,
 * without a port or a trailing dot. `null` when what is left is not a host
 * name, so it never matches a declaration.
 */
export const requestedNetworkHost = (requested: string): string | null => {
  const host = requested
    .trim()
    .toLowerCase()
    .replace(/:\d{1,5}$/u, "")
    .replace(/\.$/u, "");
  return HOST_NAME_PATTERN.test(host) ? host : null;
};
