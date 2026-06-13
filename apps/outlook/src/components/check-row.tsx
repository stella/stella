import { AlertTriangleIcon, InfoIcon } from "lucide-react";

import { cn } from "@stll/ui/lib/utils";

import type { DraftCheck } from "@/types";

export const CheckRow = ({ check }: { check: DraftCheck }) => (
  <div
    className={cn("flex gap-2 rounded-lg border p-2.5", SURFACE[check.type])}
  >
    <span className={cn("mt-0.5 inline-flex", ICON_TONE[check.type])}>
      {check.type === "info" ? <InfoIcon /> : <AlertTriangleIcon />}
    </span>
    <span className="min-w-0">
      <span className="block text-xs/4.5 font-bold">{check.title}</span>
      <span className="text-muted-foreground block text-xs/4.5 [overflow-wrap:anywhere]">
        {check.description}
      </span>
    </span>
  </div>
);

const SURFACE: Record<DraftCheck["type"], string> = {
  info: "border-border",
  risk: "border-destructive/24 bg-destructive/8",
  warning: "border-warning/24 bg-warning/8",
};

const ICON_TONE: Record<DraftCheck["type"], string> = {
  info: "text-info-foreground",
  risk: "text-destructive-foreground",
  warning: "text-warning-foreground",
};
