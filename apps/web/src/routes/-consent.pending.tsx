import {
  ConsentCardShell,
  consentChromePending,
} from "@/components/oauth-consent/consent-card-shell.pending";
import {
  ConsentAccountRowsPending,
  ConsentActingAsPending,
  ConsentDecisionBarPending,
} from "@/components/oauth-consent/consent-control-faces.pending";
import { ScopeSummaryPending } from "@/components/oauth-consent/scope-summary.pending";
import { PendingText } from "@/components/pending-text";
import { framePendingView } from "@/routes/-pending-view.logic";

export { ConsentCardShell };

export const ConsentPending = framePendingView(() => (
  <ConsentCardShell
    {...consentChromePending}
    details={<div aria-hidden="true" className="size-11" />}
    decision={<ConsentDecisionBarPending />}
  >
    <ConsentAccountRowsPending />
    <ConsentActingAsPending />
    <ScopeSummaryPending />
    <p className="text-muted-foreground text-xs text-pretty">
      <PendingText id="consent.connectionDuration" barClassName="w-56" />
    </p>
  </ConsentCardShell>
));
