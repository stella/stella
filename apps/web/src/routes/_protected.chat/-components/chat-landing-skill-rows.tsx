import { panic } from "better-result";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import { LandingEmpty, LandingItemText } from "@stll/ui/landing";

import { QueryViewFeedback } from "@/components/query-view-feedback";
import { StellaMark } from "@/components/stella-mark";
import Tooltip from "@/components/tooltip";
import { UserIdentityAvatar } from "@/components/user-avatar";
import { getDisplayName } from "@/lib/get-display-name";
import type {
  SuggestedSkill,
  SuggestedSkills,
} from "@/lib/prompts/use-suggested-skills";
import { formatRelativeTime } from "@/lib/relative-time";
import { LandingQueryFeedback } from "@/routes/_protected.chat/-components/landing-query-feedback";

type ChatLandingSkillRowsProps = {
  onSelect: (skill: SuggestedSkill) => void;
  suggestions: SuggestedSkills;
};

/**
 * The chat home's skills column: placeholder rows until the skills are read,
 * then the suggestions, or the empty line only once there are truly none.
 */
export const ChatLandingSkillRows = ({
  onSelect,
  suggestions,
}: ChatLandingSkillRowsProps) => {
  const t = useTranslations();
  switch (suggestions.type) {
    case "pending":
      return <LandingQueryFeedback view={suggestions} />;
    case "error":
      return <QueryViewFeedback view={suggestions.feedback} />;
    case "loaded":
      return (
        <>
          <QueryViewFeedback view={suggestions.feedback} />
          {suggestions.skills.length > 0 ? (
            suggestions.skills.map((skill) => (
              <SuggestedSkillRow
                key={skill.id}
                onSelect={() => onSelect(skill)}
                skill={skill}
              />
            ))
          ) : (
            <LandingEmpty>{t("chat.landing.noSkills")}</LandingEmpty>
          )}
        </>
      );
    default:
      suggestions satisfies never;
      return panic("Unhandled suggested skills state");
  }
};

type SuggestedSkillRowProps = {
  onSelect: () => void;
  skill: SuggestedSkill;
};

/**
 * A suggested skill, signed on the right by its author: the member who last
 * edited it, or stella for a built-in or unedited bundled skill. An author
 * the data cannot name (a former member, a system write) shows nothing.
 */
const SuggestedSkillRow = ({ onSelect, skill }: SuggestedSkillRowProps) => (
  <Button
    className="group/row group flex w-full"
    onClick={onSelect}
    variant="plain"
  >
    {/* The landing row's inset, gap and hover tint, so the row lines up and
        lights like the matter and thread links beside it. */}
    <span className="group-hover/row:bg-accent/50 flex w-full items-center gap-3 rounded-md px-2 py-1.5">
      <span className="min-w-0 flex-1">
        <LandingItemText meta={skill.body} title={skill.name} />
      </span>
      <SkillAuthorAvatar author={skillAuthor(skill)} />
    </span>
  </Button>
);

type SkillAuthor =
  | {
      type: "member";
      edit: Extract<SuggestedSkill["lastEdit"], { type: "user" }>;
    }
  | { type: "stella" }
  | { type: "unknown" };

const skillAuthor = ({ lastEdit }: SuggestedSkill): SkillAuthor => {
  if (lastEdit === null) {
    return { type: "unknown" };
  }
  switch (lastEdit.type) {
    case "user":
      return { type: "member", edit: lastEdit };
    case "stella":
      return { type: "stella" };
    case "unattributed":
      return { type: "unknown" };
    default: {
      lastEdit satisfies never;
      return panic(`Unhandled skill last edit: ${String(lastEdit)}`);
    }
  }
};

const AVATAR_RING_CLASS =
  "ring-background inline-flex shrink-0 rounded-full ring-2";

const SkillAuthorAvatar = ({ author }: { author: SkillAuthor }) => {
  const t = useTranslations();
  switch (author.type) {
    case "member": {
      const name =
        getDisplayName(author.edit.user.name) ?? t("common.unknownUser");
      return (
        <Tooltip
          content={t("chat.landing.skillEditedBy", {
            name,
            time: formatRelativeTime(author.edit.at),
          })}
          render={<span className={AVATAR_RING_CLASS} />}
        >
          <UserIdentityAvatar
            className="size-6"
            image={author.edit.user.image}
            name={name}
          />
        </Tooltip>
      );
    }
    case "stella":
      return (
        <Tooltip
          content={t("catalogue.firstParty")}
          render={<span className={AVATAR_RING_CLASS} />}
        >
          <span className="bg-muted text-foreground flex size-6 items-center justify-center rounded-full">
            <StellaMark className="size-3.5" />
          </span>
        </Tooltip>
      );
    case "unknown":
      return null;
    default: {
      author satisfies never;
      return panic(`Unhandled skill author: ${String(author)}`);
    }
  }
};
