import { LockIcon } from "lucide-react";

import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from "@stll/ui/components/avatar";
import {
  TooltipPopup,
  Tooltip as TooltipRoot,
  TooltipTrigger,
} from "@stll/ui/components/tooltip";
import { cn } from "@stll/ui/lib/utils";

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
      <LockIcon className="text-warning size-3" />
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
