import type { PropsWithChildren } from "react";

import { AlertTriangleIcon, CheckCircle2Icon, InfoIcon } from "@stll/ui/icons";
import { cn } from "@stll/ui/lib/utils";
import {
  List,
  ListItem,
  ListItemContent,
  ListItemMedia,
  ListItemTitle,
} from "@stll/ui/list";

type NoticeTone = "info" | "risk" | "success" | "warning";

type NoticeProps = PropsWithChildren<{
  role?: "alert" | "status";
  title: string;
  tone: NoticeTone;
}>;

/**
 * One outcome or problem, drawn as a single row of the design system's list:
 * a tinted glyph tile, the title, and the explanation under it.
 */
export const Notice = ({ children, role, title, tone }: NoticeProps) => (
  <div role={role}>
    <List>
      <ListItem className="min-h-0 items-start px-3 py-3">
        <ListItemMedia className={cn("size-7", MEDIA_TONE[tone])}>
          <ToneIcon tone={tone} />
        </ListItemMedia>
        <ListItemContent className="pt-0.5">
          <ListItemTitle variant="statement">{title}</ListItemTitle>
          {children === undefined ? null : (
            <div className="text-muted-foreground text-xs/5 [overflow-wrap:anywhere]">
              {children}
            </div>
          )}
        </ListItemContent>
      </ListItem>
    </List>
  </div>
);

const ToneIcon = ({ tone }: { tone: NoticeTone }) => {
  if (tone === "success") {
    return <CheckCircle2Icon />;
  }
  if (tone === "info") {
    return <InfoIcon />;
  }
  return <AlertTriangleIcon />;
};

const MEDIA_TONE: Record<NoticeTone, string> = {
  info: "bg-info/10 text-info-foreground",
  risk: "bg-destructive/10 text-destructive-foreground",
  success: "bg-success/10 text-success-foreground",
  warning: "bg-warning/10 text-warning-foreground",
};
