import { useTranslations } from "use-intl";

const isUnknownList = (value: unknown): value is readonly unknown[] =>
  Array.isArray(value);

/**
 * The fields a template tool could not fill with real values: in anonymized
 * mode it reports each field whose value kept a placeholder that could not be
 * mapped back (`unrestoredFields` on its output).
 */
const unrestoredFieldsOf = (output: unknown): string[] => {
  if (typeof output !== "object" || output === null) {
    return [];
  }
  const fields: unknown = Reflect.get(output, "unrestoredFields");
  return isUnknownList(fields)
    ? fields.filter((field): field is string => typeof field === "string")
    : [];
};

/** Names the fields a template tool could not fill with real values. */
export const UnrestoredFieldsNotice = ({ output }: { output: unknown }) => {
  const t = useTranslations();
  const fields = unrestoredFieldsOf(output);
  if (fields.length === 0) {
    return null;
  }
  return (
    <p className="text-muted-foreground max-w-xl py-1 text-xs" role="status">
      {t("chat.toolCall.unrestoredFields", {
        count: fields.length,
        fields: fields.join(", "),
      })}
    </p>
  );
};
