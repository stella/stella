import type { ReactNode } from "react";

import { FaceLabelPending } from "@stll/ui/control-face";

export const ScopeSummaryLayout = ({
  summary,
  notice,
  permissions,
}: {
  summary: ReactNode;
  notice?: ReactNode;
  permissions: ReactNode;
}) => (
  <section className="flex flex-col gap-3">
    <ul className="flex flex-col gap-2 text-sm">{summary}</ul>
    {notice}
    {permissions}
  </section>
);

export const ScopeSummaryPending = () => (
  <ScopeSummaryLayout
    summary={
      <>
        <li aria-hidden="true">
          <FaceLabelPending className="w-10/12" />
        </li>
        {/* The common desktop read summary fits one line. */}
        <li aria-hidden="true" className="sm:hidden">
          <FaceLabelPending className="w-6/12" />
        </li>
      </>
    }
    permissions={
      <div aria-hidden="true" className="flex min-h-11 items-center text-sm">
        <FaceLabelPending className="w-36" />
      </div>
    }
  />
);
