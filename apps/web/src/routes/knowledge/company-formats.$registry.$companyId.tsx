import { createFileRoute } from "@tanstack/react-router";

import { CompanyFormatPage } from "@/routes/knowledge/-member/company-format.page";
import { CompanyFormatPending } from "@/routes/knowledge/-member/company-format.pending";

export const Route = createFileRoute(
  "/knowledge/company-formats/$registry/$companyId",
)({
  component: CompanyFormatPage,
  pendingComponent: CompanyFormatPending,
});
