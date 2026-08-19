import { cn } from "@stll/ui/utils";

import { UserIdentity } from "@/components/user-avatar";
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
    <UserIdentity
      as="span"
      avatarClassName={avatarClassName}
      deleted={isDeleted}
      image={mention.image}
      name={mention.name}
      nameClassName="text-inherit font-normal"
      {...(className === undefined ? {} : { className: cn(className) })}
      {...(mention.hideAvatar === undefined
        ? {}
        : { hideAvatar: mention.hideAvatar })}
    />
  );
};
