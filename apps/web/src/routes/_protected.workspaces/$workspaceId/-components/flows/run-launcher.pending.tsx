import type { ReactNode } from "react";

import { ButtonFace, InputFace } from "@stll/ui/control-face";
import { PlayIcon } from "@stll/ui/icons";
import { Skeleton } from "@stll/ui/skeleton";

import { PendingText } from "@/components/pending-text";

export const RunLauncherFrame = ({ children }: { children: ReactNode }) => (
  <div className="grid gap-4 rounded-lg border p-4">{children}</div>
);

export const RunLauncherSkeleton = () => (
  <RunLauncherFrame>
    <div className="grid gap-1.5">
      <span className="text-sm font-medium">
        <PendingText id="flows.runs.selectFlow" />
      </span>
      <InputFace />
    </div>
    <div className="grid gap-1.5">
      <Skeleton className="h-5 w-28" />
      <div className="rounded-md border p-2">
        <Skeleton className="m-2 h-4 w-2/3" />
      </div>
    </div>
    <div className="flex justify-end">
      <ButtonFace size="default" variant="default">
        <PlayIcon />
        <PendingText id="common.start" />
      </ButtonFace>
    </div>
  </RunLauncherFrame>
);
