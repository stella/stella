import { LockIcon } from "lucide-react";

import {
  TooltipPopup,
  Tooltip as TooltipRoot,
  TooltipTrigger,
} from "@stll/ui/tooltip";
import { cn } from "@stll/ui/utils";

import { UserAvatar } from "@/components/user-avatar";

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
      <UserAvatar
        className="size-4"
        fallbackClassName="text-[7px]"
        image={image}
        name={name}
      />
    </TooltipTrigger>
    <TooltipPopup>{name}</TooltipPopup>
  </TooltipRoot>
);
