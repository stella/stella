import type { PropsWithChildren } from "react";

import { AlertTriangleIcon, CheckCircle2Icon, InfoIcon } from "lucide-react";

import { cn } from "@stll/ui/lib/utils";

type NoticeTone = "info" | "risk" | "success" | "warning";

type NoticeProps = PropsWithChildren<{
  title: string;
  tone: NoticeTone;
}>;

export const Notice = ({ children, title, tone }: NoticeProps) => (
  <div
    className={cn("rounded-lg border p-2.5 text-xs/4.5", TONE_SURFACE[tone])}
  >
    <div className="mb-1 flex items-center gap-1.5 font-bold">
      <ToneIcon tone={tone} />
      {title}
    </div>
    <div className="text-muted-foreground">{children}</div>
  </div>
);

const ToneIcon = ({ tone }: { tone: NoticeTone }) => {
  if (tone === "success") {
    return <CheckCircle2Icon className={ICON_TONE[tone]} />;
  }
  if (tone === "info") {
    return <InfoIcon className={ICON_TONE[tone]} />;
  }
  return <AlertTriangleIcon className={ICON_TONE[tone]} />;
};

const TONE_SURFACE: Record<NoticeTone, string> = {
  info: "border-info/24 bg-info/8",
  risk: "border-destructive/24 bg-destructive/8",
  success: "border-success/24 bg-success/8",
  warning: "border-warning/24 bg-warning/8",
};

const ICON_TONE: Record<NoticeTone, string> = {
  info: "text-info-foreground",
  risk: "text-destructive-foreground",
  success: "text-success-foreground",
  warning: "text-warning-foreground",
};
