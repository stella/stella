import { useTranslations } from "use-intl";

export const OriginalSignature = ({ domain }: { domain: string | null }) => {
  const t = useTranslations();
  if (domain === null) {
    return null;
  }
  return (
    <span className="block">
      {t.rich("correspondence.originalSignatureVerified", {
        domain,
        identifier: (chunks) => <bdi dir="ltr">{chunks}</bdi>,
      })}
    </span>
  );
};
