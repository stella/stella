import { useTranslations } from "use-intl";

import { SecretInput as SecretInputPrimitive } from "@stll/ui/secret-input";
import type { SecretInputProps as SecretInputPrimitiveProps } from "@stll/ui/secret-input";

type SecretInputProps = Omit<
  SecretInputPrimitiveProps,
  "hideValueLabel" | "showValueLabel"
>;

const SecretInput = (props: SecretInputProps) => {
  const t = useTranslations("common");

  return (
    <SecretInputPrimitive
      {...props}
      // After the spread on purpose: this wrapper exists to own the translated
      // labels, and the props type omits them so callers cannot. The omit only
      // rejects a literal attribute, though — a props object typed wider stays
      // assignable and carries an untranslated label through the spread.
      hideValueLabel={t("hideSecretValue")}
      showValueLabel={t("showSecretValue")}
    />
  );
};

export { SecretInput };
