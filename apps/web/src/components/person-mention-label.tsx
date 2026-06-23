import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from "@stll/ui/components/avatar";
import { cn } from "@stll/ui/lib/utils";

import { getInitials } from "@/lib/get-initials";
import type { PersonMention } from "@/lib/types";

type PersonMentionLabelProps = {
  mention: PersonMention;
  className?: string;
  avatarClassName?: string;
};

export const PersonMentionLabel = ({
  mention,
  className,
  avatarClassName = "size-5 shrink-0 text-[8px]",
}: PersonMentionLabelProps) => {
  const isDeleted =
    mention.deletedAt !== null && mention.deletedAt !== undefined;

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5",
        isDeleted && "text-muted-foreground",
        className,
      )}
    >
      {!mention.hideAvatar && (
        <Avatar
          className={cn(avatarClassName, isDeleted && "opacity-60 grayscale")}
        >
          {mention.image && (
            <AvatarImage alt={mention.name} src={mention.image} />
          )}
          <AvatarFallback
            className={cn(isDeleted && "bg-muted text-muted-foreground")}
          >
            {getInitials(mention.name)}
          </AvatarFallback>
        </Avatar>
      )}
      {mention.name}
    </span>
  );
};
