import type { ComponentProps } from "react";

import { Avatar, AvatarFallback, AvatarImage } from "@stll/ui/avatar";
import { BidiText } from "@stll/ui/bidi-text";
import { cn } from "@stll/ui/utils";

import { getDisplayName } from "@/lib/get-display-name";
import { getInitials } from "@/lib/get-initials";

/**
 * Shown when a user has neither a name nor an email to fall back on.
 * Not translated, matching the label this component has always rendered
 * for that state; every identity surface in the app shows the same string.
 */
export const UNKNOWN_USER_LABEL = "Unknown user";

type UserAvatarProps = Omit<
  ComponentProps<typeof Avatar>,
  "children" | "className"
> & {
  image?: string | null | undefined;
  name?: string | null;
  deleted?: boolean | undefined;
  className?: string | undefined;
  fallbackClassName?: string | undefined;
};

export const UserAvatar = ({
  deleted = false,
  image,
  name,
  className,
  fallbackClassName,
  ...avatarProps
}: UserAvatarProps) => {
  const displayName = getDisplayName(name) ?? UNKNOWN_USER_LABEL;

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

type UserIdentityProps = {
  as?: "div" | "span";
  image?: string | null | undefined;
  name?: string | null;
  deleted?: boolean | undefined;
  hideAvatar?: boolean;
  secondaryText?: string | null;
  className?: string;
  avatarClassName?: string;
  avatarFallbackClassName?: string;
  nameClassName?: string | undefined;
  secondaryClassName?: string | undefined;
};

export const UserIdentity = ({
  as: element = "div",
  deleted = false,
  hideAvatar = false,
  image,
  name,
  secondaryText,
  className,
  avatarClassName = "size-8 shrink-0 text-[0.625rem]",
  avatarFallbackClassName,
  nameClassName,
  secondaryClassName,
}: UserIdentityProps) => {
  const displayName = getDisplayName(name, secondaryText) ?? UNKNOWN_USER_LABEL;
  const Component = element;

  return (
    <Component className={cn("flex min-w-0 items-center gap-2", className)}>
      {hideAvatar ? null : (
        <UserAvatar
          className={avatarClassName}
          deleted={deleted}
          fallbackClassName={avatarFallbackClassName}
          image={image}
          name={displayName}
        />
      )}
      <Component className="min-w-0 flex-1">
        <BidiText
          as={element}
          className={cn(
            "truncate text-sm font-medium",
            element === "span" && "block",
            deleted && "text-muted-foreground",
            nameClassName,
          )}
        >
          {displayName}
        </BidiText>
        {secondaryText ? (
          <BidiText
            as={element}
            className={cn(
              "text-muted-foreground truncate text-xs",
              element === "span" && "block",
              secondaryClassName,
            )}
          >
            {secondaryText}
          </BidiText>
        ) : null}
      </Component>
    </Component>
  );
};
