import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from "@stella/ui/components/avatar";
import { cn } from "@stella/ui/lib/utils";

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
}: PersonMentionLabelProps) => (
  <span className={cn("inline-flex items-center gap-1.5", className)}>
    {!mention.hideAvatar && (
      <Avatar className={avatarClassName}>
        {mention.image && (
          <AvatarImage alt={mention.name} src={mention.image} />
        )}
        <AvatarFallback>{getInitials(mention.name)}</AvatarFallback>
      </Avatar>
    )}
    {mention.name}
  </span>
);
