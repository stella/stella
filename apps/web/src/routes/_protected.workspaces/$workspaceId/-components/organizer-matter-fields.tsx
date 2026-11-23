import { useTranslations } from "use-intl";

import type { ContactType } from "@stll/api-contract";
import { DEFAULT_VARCHAR_MAX_LENGTH } from "@stll/api-contract/limits";
import { Field, FieldLabel } from "@stll/ui/field";
import { Input } from "@stll/ui/input";

import {
  CONTACT_PICKER_SUGGESTIONS,
  ContactPicker,
} from "@/components/contact-picker";
import { SelectedClient } from "@/components/workspaces/create-matter-dialog";

export type OrganizerMatterDraft = {
  name: string;
  /** A null id is a contact the apply step creates first. */
  client: { id: string | null; displayName: string; type: ContactType } | null;
};

type OrganizerMatterFieldsProps = {
  disabled: boolean;
  onChange: (value: OrganizerMatterDraft) => void;
  value: OrganizerMatterDraft;
};

export const OrganizerMatterFields = ({
  disabled,
  onChange,
  value,
}: OrganizerMatterFieldsProps) => {
  const t = useTranslations();

  return (
    <div className="mb-4 flex flex-col gap-4 rounded-lg border p-3">
      <Field>
        <FieldLabel>{t("workspaces.create.matterName")}</FieldLabel>
        <Input
          disabled={disabled}
          maxLength={DEFAULT_VARCHAR_MAX_LENGTH}
          onChange={(e) => onChange({ ...value, name: e.currentTarget.value })}
          value={value.name}
        />
      </Field>
      <Field className="gap-3">
        <FieldLabel>{t("workspaces.parties.client")}</FieldLabel>
        {value.client ? (
          <SelectedClient
            clearLabel={t("workspaces.parties.removeClient")}
            client={value.client}
            onClear={() => onChange({ ...value, client: null })}
          />
        ) : null}
        <ContactPicker
          onCreate={(displayName, type) =>
            onChange({ ...value, client: { id: null, displayName, type } })
          }
          onSelect={(contact) =>
            onChange({
              ...value,
              client: {
                id: contact.id,
                displayName: contact.displayName,
                type: contact.type,
              },
            })
          }
          placeholder={
            value.client
              ? t("workspaces.parties.changeClient")
              : t("workspaces.parties.noClientOptional")
          }
          suggestions={CONTACT_PICKER_SUGGESTIONS.recentClients}
        />
        {value.client === null ? (
          <p className="text-muted-foreground text-xs">
            {t("workspaces.create.personalDescription")}
          </p>
        ) : null}
        {value.client?.id === null ? (
          <p className="text-muted-foreground text-xs">
            {t("workspaces.importOrganizer.newClientHint")}
          </p>
        ) : null}
      </Field>
    </div>
  );
};
