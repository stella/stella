import {
  ConsentCardShell,
  consentChromePending,
} from "@/components/oauth-consent/consent-card-shell.pending";
import {
  ConsentActingAsPending,
  ConsentDecisionBarPending,
  ConsentOrganizationPending,
  OAuthAccountList,
  OAuthAccountRowPending,
} from "@/components/oauth-consent/consent-control-faces.pending";
import { ScopeSummaryPending } from "@/components/oauth-consent/scope-summary.pending";
import { PendingText } from "@/components/pending-text";
import { framePendingView } from "@/routes/-pending-view.logic";

export { ConsentCardShell };

export const ConsentPending = framePendingView(() => (
  <ConsentCardShell
    {...consentChromePending}
    details={null}
    decision={<ConsentDecisionBarPending />}
  >
    <OAuthAccountList>
      <OAuthAccountRowPending />
      <ConsentOrganizationPending />
    </OAuthAccountList>
    <ConsentActingAsPending />
    <ScopeSummaryPending />
    <p className="text-muted-foreground text-xs text-pretty">
      <PendingText id="consent.connectionDuration" barClassName="w-56" />
    </p>
  </ConsentCardShell>
));
