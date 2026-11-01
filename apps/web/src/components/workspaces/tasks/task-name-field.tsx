import { useTranslations } from "use-intl";

import { ENTITY_NAME_MAX_LENGTH } from "@stll/api-contract";
import { InlineRenameInput } from "@stll/ui/inline-rename";

import { InspectorTitle } from "@/components/inspector/inspector-title";
import { useMountEffect } from "@/hooks/use-effect";
import { useInlineRename } from "@/hooks/use-inline-rename";
import { useFormatter } from "@/i18n/formatting-context";
import { detached } from "@/lib/detached";

/** How close to the limit the name starts showing its length. */
const LENGTH_COUNTER_MARGIN = 25;

type TaskNameFieldProps = {
  /** A new task opens with its name ready to type. */
  autoEdit: boolean;
  name: string;
  onRename: (name: string, showError: (message: string) => void) => void;
};

export const TaskNameField = ({
  autoEdit,
  name,
  onRename,
}: TaskNameFieldProps) => {
  const t = useTranslations("tasks");
  const format = useFormatter();
  const rename = useInlineRename({
    initial: name,
    onCommit: (nextName, { setError }) => onRename(nextName, setError),
  });
  useMountEffect(() => {
    if (autoEdit) {
      rename.startEditing("");
    }
  });

  if (rename.state.mode === "view") {
    return (
      <InspectorTitle
        isEmpty={name === ""}
        onEdit={() => rename.startEditing()}
      >
        {name === "" ? t("untitled") : name}
      </InspectorTitle>
    );
  }

  const { draft, error } = rename.state;
  return (
    <span className="block min-w-0 text-base font-semibold">
      <InlineRenameInput
        aria-invalid={error !== undefined}
        maxLength={ENTITY_NAME_MAX_LENGTH}
        onCancel={rename.cancel}
        onCommit={() => detached(rename.commit(), "task-name-field.rename")}
        onValueChange={rename.setDraft}
        placeholder={t("untitled")}
        value={draft}
      />
      {draft.length >= ENTITY_NAME_MAX_LENGTH - LENGTH_COUNTER_MARGIN && (
        <span className="text-muted-foreground block text-xs font-normal tabular-nums">
          {format.number(draft.length)}/{format.number(ENTITY_NAME_MAX_LENGTH)}
        </span>
      )}
      {error !== undefined && (
        <span
          className="text-destructive block text-xs font-normal"
          role="alert"
        >
          {error}
        </span>
      )}
    </span>
  );
};
