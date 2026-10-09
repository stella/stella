import type { ProviderDiagnostic } from "@stll/api-contract/provider-setup";

import { CopyActionButton } from "@/components/copy-action-button";
import { ProviderDiagnosticContent } from "@/components/provider-diagnostic-content";

export const ProviderDiagnosticMessage = ({
  diagnostic,
}: {
  diagnostic: ProviderDiagnostic;
}) => (
  <div className="space-y-2">
    <ProviderDiagnosticContent diagnostic={diagnostic} />
    <CopyActionButton
      size="xs"
      text={`${diagnostic.provider}: ${diagnostic.message}`}
      variant="ghost"
    />
  </div>
);
