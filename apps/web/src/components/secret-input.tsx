import { useTranslations } from "use-intl";

import { SecretInput as SecretInputPrimitive } from "@stll/ui/components/secret-input";
import type { SecretInputProps as SecretInputPrimitiveProps } from "@stll/ui/components/secret-input";

type SecretInputProps = Omit<
  SecretInputPrimitiveProps,
  "hideValueLabel" | "showValueLabel"
>;

const SecretInput = (props: SecretInputProps) => {
  const t = useTranslations("common");

  return (
    <SecretInputPrimitive
      hideValueLabel={t("hideSecretValue")}
      showValueLabel={t("showSecretValue")}
      {...props}
    />
  );
};

export { SecretInput };
