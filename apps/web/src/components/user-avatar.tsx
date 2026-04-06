import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from "@stella/ui/components/avatar";
import { cn } from "@stella/ui/lib/utils";

import { getInitials } from "@/lib/get-initials";

type UserAvatarProps = {
  image?: string | null | undefined;
  name?: string | null;
  className?: string | undefined;
  fallbackClassName?: string | undefined;
};

export const UserAvatar = ({
  image,
  name,
  className,
  fallbackClassName,
}: UserAvatarProps) => {
  const displayName = name?.trim() || "Unknown user";

  return (
    <Avatar className={className}>
      {image ? <AvatarImage alt={displayName} src={image} /> : null}
      <AvatarFallback className={fallbackClassName}>
        {getInitials(name ?? null)}
      </AvatarFallback>
    </Avatar>
  );
};

type UserIdentityProps = {
  image?: string | null | undefined;
  name?: string | null;
  secondaryText?: string | null;
  className?: string;
  avatarClassName?: string;
  avatarFallbackClassName?: string;
  nameClassName?: string | undefined;
  secondaryClassName?: string | undefined;
};

export const UserIdentity = ({
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
        fallbackClassName={avatarFallbackClassName}
        image={image}
        name={displayName}
      />
      <div className="min-w-0 flex-1">
        <div className={cn("truncate text-sm font-medium", nameClassName)}>
          {displayName}
        </div>
        {secondaryText ? (
          <div
            className={cn(
              "text-muted-foreground truncate text-xs",
              secondaryClassName,
            )}
          >
            {secondaryText}
          </div>
        ) : null}
      </div>
    </div>
  );
};
