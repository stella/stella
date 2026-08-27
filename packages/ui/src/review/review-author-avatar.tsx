import type { ComponentProps } from "react";

import { Avatar, AvatarFallback, AvatarImage } from "../components/avatar";
import { getInitials } from "../lib/initials";
import { cn } from "../lib/utils";

/**
 * Shown when an author has neither a name nor anything to fall back on. This
 * package carries no catalogs, so a localized host passes `fallbackLabel`;
 * the constant is exported so every surface that needs the same placeholder
 * outside an avatar reads it from here rather than minting its own.
 */
export const UNKNOWN_AUTHOR_LABEL = "Unknown user";

type ReviewAuthorAvatarProps = Omit<
  ComponentProps<typeof Avatar>,
  "children" | "className"
> & {
  image?: string | null | undefined;
  name?: string | null;
  deleted?: boolean | undefined;
  fallbackLabel?: string;
  className?: string | undefined;
  fallbackClassName?: string | undefined;
};

/** The author's face on any review surface: image when there is one, initials
 *  otherwise, dimmed once the account is gone. */
export const ReviewAuthorAvatar = ({
  deleted = false,
  image,
  name,
  fallbackLabel = UNKNOWN_AUTHOR_LABEL,
  className,
  fallbackClassName,
  ...avatarProps
}: ReviewAuthorAvatarProps) => {
  // A stored name may be the empty string (signup leaves it blank and the
  // column still admits ""), which would render an avatar with no alt text.
  const displayName = name?.trim() || fallbackLabel;

  return (
    <Avatar
      {...avatarProps}
      className={cn(className, deleted && "opacity-60 grayscale")}
    >
      {image ? <AvatarImage alt={displayName} src={image} /> : null}
      <AvatarFallback
        className={cn(
          fallbackClassName,
          deleted && "bg-muted text-muted-foreground",
        )}
      >
        {getInitials(name ?? null)}
      </AvatarFallback>
    </Avatar>
  );
};
