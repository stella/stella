import { useTranslations } from "use-intl";

import { LandmarkIcon } from "@stll/ui/icons";
import { MatterIcon } from "@stll/ui/matter-icon";

import type {
  ChatMentionOption,
  ChatReferenceCategory,
} from "@/components/chat-mention-extension";
import { EntityIcon } from "@/components/workspaces/entity-kind-icon";
import type { TranslationKey } from "@/i18n/types";

const CATEGORY_LABEL_KEYS = {
  entity: "chat.mention.category.entities",
  workspace: "common.matters",
  decision: "common.caseLaw",
} as const satisfies Record<ChatReferenceCategory, TranslationKey>;

/** The order mention results group in, wherever a picker lists them. */
export const MENTION_CATEGORY_ORDER = [
  "entity",
  "workspace",
  "decision",
] as const satisfies readonly ChatReferenceCategory[];

type MissingCategory = Exclude<
  ChatReferenceCategory,
  (typeof MENTION_CATEGORY_ORDER)[number]
>;

true satisfies MissingCategory extends never ? true : never;

export const useMentionCategoryLabel = () => {
  const t = useTranslations();
  return (category: ChatReferenceCategory): string =>
    t(CATEGORY_LABEL_KEYS[category]);
};

/** Resolves the category/kind-appropriate glyph for a mention row, so every
 *  picker renders byte-identical icons for the same options. */
export const MentionIcon = ({ mention }: { mention: ChatMentionOption }) => {
  if (mention.category === "workspace") {
    return (
      <MatterIcon
        className="size-3.5 shrink-0"
        matter={{ id: mention.resource.id, color: null }}
      />
    );
  }

  if (mention.category === "decision") {
    return <LandmarkIcon className="text-muted-foreground size-3.5 shrink-0" />;
  }

  return (
    <EntityIcon
      className="text-muted-foreground size-3.5 shrink-0"
      source={{
        type: "resolved",
        kind: mention.kind,
        mimeType: mention.mimeType,
      }}
    />
  );
};
