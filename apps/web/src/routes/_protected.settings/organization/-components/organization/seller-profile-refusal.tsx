import { useTranslations } from "use-intl";

import { userErrorFromThrown } from "@/lib/errors/user-safe";

export const SellerProfileRefusal = ({ error }: { error: unknown }) => {
  const t = useTranslations();
  return (
    <p className="text-destructive text-sm" role="alert">
      {userErrorFromThrown(error, t("errors.actionFailed"))}
    </p>
  );
};
