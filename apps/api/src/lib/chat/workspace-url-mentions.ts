import { brandPersistedWorkspaceId } from "@/api/lib/safe-id-boundaries";

import type { ChatRefRegistry } from "./ref-registry";
import { CHAT_WORKSPACE_REF_PREFIX } from "./ref-registry";

const UUID_PATTERN =
  "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const REGEX_SPECIAL_CHARS = /[.*+?^${}()|[\]\\]/gu;

type RewriteWorkspaceUrlsProps = {
  /** `getAppBaseUrl()` — the deployment's frontend origin, no trailing slash. */
  appBaseUrl: string;
  refRegistry: ChatRefRegistry;
  text: string;
};

/**
 * Rewrite pasted stella workspace URLs in user text into workspace mention
 * links before the text reaches the model. "Copy link" on a matter (and the
 * browser URL bar) yields `<origin>/workspaces/<uuid>[/...]`; without this
 * rewrite the model-ingress guard redacts the UUID and the user's intent
 * ("this matter") is lost. The rewrite preserves it as a chat ref the model
 * can act on. Deeper path segments (view ids, sub-routes) are consumed into
 * the same workspace mention — views have no chat ref kind.
 *
 * Only the model-facing hydrated copy changes; the persisted user message
 * keeps the original URL for display.
 */
export const rewriteWorkspaceUrlsToMentions = ({
  appBaseUrl,
  refRegistry,
  text,
}: RewriteWorkspaceUrlsProps): string => {
  if (appBaseUrl.length === 0 || !text.includes("/workspaces/")) {
    return text;
  }
  const escapedBase = appBaseUrl.replaceAll(REGEX_SPECIAL_CHARS, "\\$&");
  const urlRegex = new RegExp(
    `${escapedBase}/workspaces/(${UUID_PATTERN})(?:/[^\\s)\\]]*)?`,
    "giu",
  );
  return text.replaceAll(urlRegex, (_url, workspaceId: string) => {
    const matterRef = refRegistry.toMatterRef(
      brandPersistedWorkspaceId(workspaceId),
    );
    return `[matter](${CHAT_WORKSPACE_REF_PREFIX}${matterRef})`;
  });
};
