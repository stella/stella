import { useTranslations } from "use-intl";

import type { ProviderDiagnostic } from "@stll/api-contract/provider-setup";
import { CopyButton } from "@stll/ui/copy-button";

import { providerSetupGuidance } from "@/lib/errors/provider-setup-guidance";
import { sanitizeHref } from "@/lib/sanitize-href";

type ProviderDiagnosticMessageProps = {
  diagnostic: ProviderDiagnostic;
};

export const ProviderDiagnosticContent = ({
  diagnostic,
}: ProviderDiagnosticMessageProps) => {
  const t = useTranslations();
  const guidance = providerSetupGuidance(diagnostic.code ?? undefined);
  return (
    <div className="min-w-0 space-y-2" role="alert">
      <p
        className="text-destructive text-sm wrap-anywhere whitespace-pre-wrap"
        dir="auto"
      >
        <bdi>{diagnostic.provider}</bdi>: {diagnostic.message}
      </p>
      {guidance !== null && (
        <div className="text-foreground space-y-1 text-sm">
          <p>{t(guidance.guidance)}</p>
          <a
            className="underline underline-offset-2"
            href={sanitizeHref(guidance.url)}
            rel="noreferrer"
            target="_blank"
          >
            {t(guidance.linkLabel)}
          </a>
        </div>
      )}
    </div>
  );
};

type ProviderDiagnosticToastProps = ProviderDiagnosticMessageProps & {
  onCopy: () => Promise<boolean>;
};

export const ProviderDiagnosticToast = ({
  diagnostic,
  onCopy,
}: ProviderDiagnosticToastProps) => {
  const t = useTranslations();
  return (
    <div className="space-y-2">
      <ProviderDiagnosticContent diagnostic={diagnostic} />
      <CopyButton
        size="xs"
        variant="ghost"
        label={t("common.copy")}
        copiedLabel={t("common.copied")}
        onCopy={onCopy}
      />
    </div>
  );
};
