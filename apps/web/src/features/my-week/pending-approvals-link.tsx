import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useTranslations } from "use-intl";

import { queryView } from "@/lib/query-view.logic";
import { timeApprovalPendingOptions } from "@/lib/workspaces/queries/time-approvals";

/**
 * For an approver: how much submitted time waits for them, linking to the
 * approvals page. A count that cannot be read shows nothing.
 */
export const PendingApprovalsLink = ({
  organizationId,
  userId,
}: {
  organizationId: string;
  userId: string;
}) => {
  const t = useTranslations("billing.approval");
  const pending = queryView(
    useQuery(timeApprovalPendingOptions(organizationId, userId)),
    { isEmpty: (count) => count === 0 },
  );
  // A hint beside the week: a count that cannot be read is left out.
  if (pending.type !== "items") {
    return null;
  }
  return (
    <Link
      className="text-sm tabular-nums underline underline-offset-4"
      to="/time/approvals"
    >
      {t("pending", { count: pending.items })}
    </Link>
  );
};
