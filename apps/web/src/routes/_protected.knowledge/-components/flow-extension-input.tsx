import { useState } from "react";

import { XIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { Input } from "@stll/ui/components/input";

// Free-text tag input for file extensions. @stll/ui has no dedicated tag input;
// this keeps the create-on-Enter + chip-remove behaviour local to the flow
// editor. Extensions are normalized to lowercase without a leading dot.

const normalizeExtension = (raw: string): string =>
  raw.trim().replace(/^\.+/u, "").toLowerCase();

export const FlowExtensionInput = ({
  extensions,
  onChange,
}: {
  extensions: string[];
  onChange: (next: string[]) => void;
}) => {
  const t = useTranslations();
  const [draft, setDraft] = useState("");

  const commit = () => {
    const value = normalizeExtension(draft);
    setDraft("");
    if (value === "" || extensions.includes(value)) {
      return;
    }
    onChange([...extensions, value]);
  };

  const remove = (extension: string) => {
    onChange(extensions.filter((existing) => existing !== extension));
  };

  return (
    <div className="grid gap-2">
      <Input
        onBlur={commit}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === ",") {
            e.preventDefault();
            commit();
          }
        }}
        placeholder={t("flows.fileUpload.extensionsPlaceholder")}
        value={draft}
      />
      {extensions.length > 0 && (
        <ul className="flex flex-wrap gap-1.5">
          {extensions.map((extension) => (
            <li key={extension}>
              <button
                aria-label={`${t("common.remove")} ${extension}`}
                className="bg-muted hover:bg-muted/70 text-muted-foreground inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs transition-colors"
                onClick={() => remove(extension)}
                type="button"
              >
                {extension}
                <XIcon className="size-3" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};
