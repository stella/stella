// Passive regression fixture for `no-adhoc-loader/no-adhoc-loader`.

import { LoaderIcon } from "lucide-react";

import { Loader, LoaderState } from "@stll/ui/loader";
import { Skeleton } from "@stll/ui/skeleton";

export const AdhocLoaderFixture = ({ busy }: { busy: boolean }) => (
  <div>
    {/* oxlint-disable-next-line no-adhoc-loader/no-adhoc-loader */}
    <LoaderIcon className="size-4" />
    {/* oxlint-disable-next-line no-adhoc-loader/no-adhoc-loader */}
    <span className="size-4 animate-spin" />
    {/* oxlint-disable-next-line no-adhoc-loader/no-adhoc-loader */}
    <div className={busy ? "bg-muted h-4 animate-pulse" : "h-4"} />
    {/* oxlint-disable-next-line no-adhoc-loader/no-adhoc-loader */}
    <div role="progressbar" />
    {/* oxlint-disable-next-line no-adhoc-loader/no-adhoc-loader */}
    <div role={"progressbar"} />

    <Loader label="Loading" size="sm" />
    <LoaderState label="Review in progress" />
    <Skeleton className="h-4 w-1/3" />
  </div>
);
