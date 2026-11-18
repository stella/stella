const SKILL_PROMPT_RESOURCE_URI_PREFIX = "stella://skills/";

/**
 * The URI a skill prompt attaches one of the skill's files under. A resource
 * path may hold spaces, `#`, `%` or non-ASCII letters, so each segment is
 * percent-encoded; the `/` between them stays.
 */
export const skillPromptResourceUri = ({
  name,
  path,
}: {
  name: string;
  path: string;
}): string =>
  `${SKILL_PROMPT_RESOURCE_URI_PREFIX}${encodeURIComponent(name)}/${path
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/")}`;
