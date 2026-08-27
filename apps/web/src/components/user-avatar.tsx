import { BidiText } from "@stll/ui/bidi-text";
import {
  ReviewAuthorAvatar,
  UNKNOWN_AUTHOR_LABEL,
} from "@stll/ui/review/review-author-avatar";
import { cn } from "@stll/ui/utils";

import { getDisplayName } from "@/lib/get-display-name";

/**
 * A user's avatar anywhere in the app.
 *
 * The rendering lives in the design system as `ReviewAuthorAvatar`, shared
 * with the review chrome; this module stays the app's single owner of user
 * identity (`no-hand-rolled-user-identity` points every call site here), so
 * the name and the app's unknown-user label are bound in one place.
 */
export const UserAvatar = ReviewAuthorAvatar;

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
  const displayName =
    getDisplayName(name, secondaryText) ?? UNKNOWN_AUTHOR_LABEL;
  const Component = element;

  return (
    <Component className={cn("flex min-w-0 items-center gap-2", className)}>
      {hideAvatar ? null : (
        <ReviewAuthorAvatar
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
