import { useTranslations } from "use-intl";

import { OutcomeScreen } from "@stll/ui/outcome-screen";

import { pageTitleLiteral } from "@/lib/page-title";

/**
 * An agent's claim, approved: where it works and what it can do there. The
 * member opened this tab from the agent, so closing it is theirs to do.
 */
export const AgentClaimConnected = ({
  organizationName,
}: {
  organizationName: string | null;
}) => {
  const t = useTranslations();
  const title = t("agentClaim.connectedTitle");
  return (
    <OutcomeScreen
      description={t("agentClaim.connectedDescription")}
      details={[
        ...(organizationName
          ? [{ label: t("common.organization"), value: organizationName }]
          : []),
        { label: t("common.access"), value: t("agentClaim.connectedAccess") },
      ]}
      documentTitle={pageTitleLiteral(title)}
      note={t("common.closeTabNote")}
      title={title}
      tone="success"
    />
  );
};
