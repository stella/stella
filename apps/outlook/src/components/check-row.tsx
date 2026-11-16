import { AlertTriangleIcon, CheckIcon } from "@stll/ui/icons";
import { cn } from "@stll/ui/lib/utils";
import {
  ListItem,
  ListItemContent,
  ListItemDescription,
  ListItemMedia,
  ListItemTitle,
} from "@stll/ui/list";

import type { DraftCheck } from "@/types";

/** One pre-send check, as a row of the checks list. */
export const CheckRow = ({ check }: { check: DraftCheck }) => (
  <ListItem className="min-h-0 items-start px-3 py-3">
    <ListItemMedia className={cn("size-7", MEDIA_TONE[check.type])}>
      {check.type === "info" ? <CheckIcon /> : <AlertTriangleIcon />}
    </ListItemMedia>
    <ListItemContent className="pt-0.5">
      <ListItemTitle variant="statement">{check.title}</ListItemTitle>
      <ListItemDescription variant="paragraph">
        {check.description}
      </ListItemDescription>
    </ListItemContent>
  </ListItem>
);

const MEDIA_TONE: Record<DraftCheck["type"], string> = {
  info: "",
  risk: "bg-destructive/10 text-destructive-foreground",
  warning: "bg-warning/10 text-warning-foreground",
};
