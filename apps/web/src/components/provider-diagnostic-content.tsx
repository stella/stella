import { useTranslations } from "use-intl";

import type { ProviderDiagnostic } from "@stll/api-contract/provider-setup";
import { sanitizeHref } from "@stll/decision-reader/sanitize-href";

import { providerSetupGuidance } from "@/lib/errors/provider-setup-guidance";

type ProviderSetupGuidanceNoticeProps = {
  /**
   * Only the setup code: the provider's own wording is not shown to readers.
   * It is untranslated, names internals ("messages.0") and offers no action;
   * the API reports it for support instead.
   */
  code: ProviderDiagnostic["code"];
};

/**
 * The fix for a provider refusal that names a known setup problem with the
 * organization's own key: what to change and where. Renders nothing for any
 * other refusal, so the surface's own translated message stands alone.
 */
export const ProviderSetupGuidanceNotice = ({
  code,
}: ProviderSetupGuidanceNoticeProps) => {
  const t = useTranslations("organization.aiConfig");
  const guidance = providerSetupGuidance(code ?? undefined);
  if (guidance === null) {
    return null;
  }
  // Phrasing elements only: a toast renders its description inside a <p>.
  return (
    <span className="text-foreground block space-y-1 text-sm">
      <span className="block">{t(guidance.guidance)}</span>
      <a
        className="underline underline-offset-2"
        href={sanitizeHref(guidance.url)}
        rel="noreferrer"
        target="_blank"
      >
        {t(guidance.linkLabel)}
      </a>
    </span>
  );
};
