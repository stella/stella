import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from "@stll/ui/components/avatar";
import { BidiText } from "@stll/ui/components/bidi-text";
import { cn } from "@stll/ui/lib/utils";

import { getInitials } from "@/lib/get-initials";

type UserAvatarProps = {
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
}: UserAvatarProps) => {
  const displayName = name?.trim() || "Unknown user";

  return (
    <Avatar className={cn(className, deleted && "opacity-60 grayscale")}>
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
  image?: string | null | undefined;
  name?: string | null;
  deleted?: boolean | undefined;
  secondaryText?: string | null;
  className?: string;
  avatarClassName?: string;
  avatarFallbackClassName?: string;
  nameClassName?: string | undefined;
  secondaryClassName?: string | undefined;
};

export const UserIdentity = ({
  deleted = false,
  image,
  name,
  secondaryText,
  className,
  avatarClassName = "size-8 shrink-0 text-[0.625rem]",
  avatarFallbackClassName,
  nameClassName,
  secondaryClassName,
}: UserIdentityProps) => {
  const displayName = name?.trim() || secondaryText?.trim() || "Unknown user";

  return (
    <div className={cn("flex min-w-0 items-center gap-2", className)}>
      <UserAvatar
        className={avatarClassName}
        deleted={deleted}
        fallbackClassName={avatarFallbackClassName}
        image={image}
        name={displayName}
      />
      <div className="min-w-0 flex-1">
        <BidiText
          as="div"
          className={cn(
            "truncate text-sm font-medium",
            deleted && "text-muted-foreground",
            nameClassName,
          )}
        >
          {displayName}
        </BidiText>
        {secondaryText ? (
          <BidiText
            as="div"
            className={cn(
              "text-muted-foreground truncate text-xs",
              secondaryClassName,
            )}
          >
            {secondaryText}
          </BidiText>
        ) : null}
      </div>
    </div>
  );
};
