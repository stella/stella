import { LockIcon } from "lucide-react";

import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from "@stella/ui/components/avatar";
import {
  TooltipPopup,
  Tooltip as TooltipRoot,
  TooltipTrigger,
} from "@stella/ui/components/tooltip";
import { cn } from "@stella/ui/lib/utils";

type ActiveEditBadgeProps = {
  name: string;
  image: string | null;
  className?: string;
};

export const ActiveEditBadge = ({
  name,
  image,
  className,
}: ActiveEditBadgeProps) => (
  <TooltipRoot>
    <TooltipTrigger
      className={cn("inline-flex items-center gap-0.5", className)}
      render={<span />}
    >
      <LockIcon className="size-3 text-amber-500" />
      <Avatar className="size-4">
        <AvatarImage alt={name} src={image ?? undefined} />
        <AvatarFallback className="text-[7px]">
          {name.slice(0, 2).toUpperCase()}
        </AvatarFallback>
      </Avatar>
    </TooltipTrigger>
    <TooltipPopup>{name}</TooltipPopup>
  </TooltipRoot>
);
