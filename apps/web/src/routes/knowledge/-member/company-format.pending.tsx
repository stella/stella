import type { ReactNode } from "react";

import { CompanyRegistryPreviewPending } from "@/components/company-registry-preview.pending";
import { framePendingView } from "@/routes/-pending-view.logic";

/** The column a company's record fills. */
export const CompanyFormatShell = ({ children }: { children: ReactNode }) => (
  <div className="mx-auto min-h-0 w-full max-w-3xl flex-1">{children}</div>
);

/** A company's record before the session and the registry are read. */
export const CompanyFormatPending = framePendingView(() => (
  <CompanyFormatShell>
    <CompanyRegistryPreviewPending />
  </CompanyFormatShell>
));
