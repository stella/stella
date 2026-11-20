import type { ReactNode } from "react";

import { ButtonFace } from "@stll/ui/control-face";
import { ArrowLeftIcon } from "@stll/ui/icons";
import { ScrollArea } from "@stll/ui/scroll-area";
import { Skeleton } from "@stll/ui/skeleton";

import { PendingText } from "@/components/pending-text";

export const RunDetailShell = ({ children }: { children: ReactNode }) => (
  <ScrollArea axis="vertical">{children}</ScrollArea>
);

export const RunDetailBody = ({ children }: { children: ReactNode }) => (
  <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 p-6">
    {children}
  </div>
);

export const RunDetailSkeleton = ({ back }: { back?: ReactNode }) => (
  <RunDetailBody>
    <div className="flex items-center gap-2">
      {back ?? (
        <ButtonFace size="sm" variant="ghost">
          <ArrowLeftIcon />
          <PendingText id="common.back" />
        </ButtonFace>
      )}
    </div>
    <div className="flex items-center gap-3">
      <Skeleton className="h-7 w-48" />
      <Skeleton className="h-5 w-16 rounded-md" />
    </div>
    <div className="space-y-2 rounded-lg border p-3">
      <Skeleton className="h-5 w-48" />
      <Skeleton className="h-4 w-32" />
    </div>
  </RunDetailBody>
);
