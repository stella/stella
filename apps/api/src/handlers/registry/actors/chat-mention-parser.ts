/** Parse `[Label](#stella-{type}=ID)` mention links from
 *  message text. Returns unique references grouped by type.
 *
 *  Entity mentions may include a workspace prefix:
 *  `#stella-entity=WS_ID:ENTITY_ID` — the workspace ID is
 *  extracted so the backend can activate tools for it. */

type MentionRef =
  | { type: "entity"; id: string; workspaceId: string | null }
  | { type: "workspace"; id: string }
  | { type: "contact"; id: string }
  | { type: "template"; id: string }
  | { type: "clause"; id: string };

const MENTION_RE =
  /\[([^\]]*)\]\(#stella-(entity|workspace|contact|template|clause)=([^)]+)\)/g;

/** Extract all mention references from a message string. */
const parseMentions = (text: string): MentionRef[] => {
  const seen = new Set<string>();
  const refs: MentionRef[] = [];

  for (const match of text.matchAll(MENTION_RE)) {
    const type = match[2];
    const rawId = match[3];
    if (!type || !rawId) {
      continue;
    }
    const key = `${type}:${rawId}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);

    if (type === "entity") {
      // Entity IDs may be prefixed: WS_ID:ENTITY_ID
      const colonIdx = rawId.indexOf(":");
      if (colonIdx > 0) {
        refs.push({
          type: "entity",
          id: rawId.slice(colonIdx + 1),
          workspaceId: rawId.slice(0, colonIdx),
        });
      } else {
        refs.push({ type: "entity", id: rawId, workspaceId: null });
      }
    } else {
      switch (type) {
        case "workspace":
          refs.push({ type: "workspace", id: rawId });
          break;
        case "contact":
          refs.push({ type: "contact", id: rawId });
          break;
        case "template":
          refs.push({ type: "template", id: rawId });
          break;
        case "clause":
          refs.push({ type: "clause", id: rawId });
          break;
        default:
          break;
      }
    }
  }

  return refs;
};

/** Extract all workspace IDs from mention references,
 *  including workspaces embedded in entity mentions. */
export const extractWorkspaceIds = (refs: MentionRef[]): string[] => {
  const ids = new Set<string>();
  for (const r of refs) {
    if (r.type === "workspace") {
      ids.add(r.id);
    }
    if (r.type === "entity" && r.workspaceId) {
      ids.add(r.workspaceId);
    }
  }
  return [...ids];
};

/** Extract all contact IDs from mention references. */
export const extractContactIds = (refs: MentionRef[]): string[] =>
  refs.filter((r) => r.type === "contact").map((r) => r.id);

/** Build entity → workspace mapping from mentions. */
export const extractEntityWorkspaceMap = (
  refs: MentionRef[],
): { entityId: string; workspaceId: string }[] => {
  const result: { entityId: string; workspaceId: string }[] = [];
  for (const r of refs) {
    if (r.type === "entity" && r.workspaceId) {
      result.push({ entityId: r.id, workspaceId: r.workspaceId });
    }
  }
  return result;
};

const ENTITY_WS_PREFIX_RE = /(#stella-entity=)([^:)]+):([^)]+)/g;

/** Strip workspace prefixes from entity mentions in text.
 *  Rewrites `#stella-entity=WS_ID:ENTITY_ID` to
 *  `#stella-entity=ENTITY_ID` so the model sees clean IDs. */
export const stripEntityWorkspacePrefixes = (text: string): string =>
  text.replace(ENTITY_WS_PREFIX_RE, "$1$3");

/** Collect all mentions from all messages in a thread. */
export const collectThreadMentions = (
  messages: { parts: { type: string; text?: string }[] }[],
): MentionRef[] => {
  const allText = messages
    .flatMap((m) =>
      // TODO: fix this
      // oxlint-disable-next-line typescript/strict-boolean-expressions
      m.parts
        .filter((p) => p.type === "text" && p.text)
        .map((p) => p.text ?? ""),
    )
    .join("\n");
  return parseMentions(allText);
};
