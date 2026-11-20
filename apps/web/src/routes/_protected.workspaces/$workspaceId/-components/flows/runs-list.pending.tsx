import type { ReactNode } from "react";

import { DirectionalIcon } from "@stll/ui/directional-icon";
import { ChevronRightIcon } from "@stll/ui/icons";
import { InlineSkeleton } from "@stll/ui/skeleton";

export const RunsListFrame = ({ children }: { children: ReactNode }) => (
  <ul className="divide-y rounded-lg border">{children}</ul>
);

export const RunRowFrame = ({ children }: { children: ReactNode }) => (
  <span className="hover:bg-muted/50 flex w-full items-center gap-3 px-4 py-3">
    {children}
  </span>
);

const RUN_ROW_KEYS = ["a", "b", "c", "d"];

export const RunsSkeleton = () => (
  <RunsListFrame>
    {RUN_ROW_KEYS.map((key) => (
      <li aria-hidden="true" key={key}>
        <RunRowFrame>
          <span className="h-5 w-16 shrink-0 overflow-hidden rounded-md">
            <InlineSkeleton className="block size-full" />
          </span>
          <span className="min-w-0 flex-1">
            <InlineSkeleton className="block h-5 w-48 max-w-full" />
            <InlineSkeleton className="mt-0.5 block h-4 w-40 max-w-full" />
          </span>
          <DirectionalIcon
            className="text-muted-foreground size-4 shrink-0"
            icon={ChevronRightIcon}
          />
        </RunRowFrame>
      </li>
    ))}
  </RunsListFrame>
);
