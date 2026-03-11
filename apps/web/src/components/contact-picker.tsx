import { useState } from "react";

import { useQuery } from "@tanstack/react-query";
import { BuildingIcon, PlusIcon, SearchIcon, UserIcon } from "lucide-react";
import { useDebouncedCallback } from "use-debounce";
import { useTranslations } from "use-intl";

import {
  Combobox,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
} from "@stella/ui/components/combobox";

import { api } from "@/lib/api";
import { toAPIError } from "@/lib/errors";

type ContactResult = {
  id: string;
  type: "person" | "organization";
  displayName: string;
  color: string | null;
};

/** Sentinel value indicating the user wants to create a new contact. */
const CREATE_PERSON_SENTINEL: ContactResult = {
  id: "__create_person__",
  type: "person",
  displayName: "",
  color: null,
};

const CREATE_ORG_SENTINEL: ContactResult = {
  id: "__create_org__",
  type: "organization",
  displayName: "",
  color: null,
};

type ContactPickerProps = {
  onSelect: (contact: ContactResult) => void;
  /** Called when the user wants to create a new contact inline. */
  onCreate?: (name: string, type: "person" | "organization") => void;
  type?: "person" | "organization";
  placeholder?: string;
  autoFocus?: boolean;
};

const searchContacts = async (q: string, type?: "person" | "organization") => {
  if (!q) {
    return [];
  }

  const response = await api.contacts.search.get({
    query: { q, type },
  });

  if (response.error) {
    throw toAPIError(response.error);
  }

  return response.data.items;
};

export const ContactPicker = ({
  onSelect,
  onCreate,
  type,
  placeholder,
  autoFocus,
}: ContactPickerProps) => {
  const t = useTranslations();
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");

  const debouncedSetQuery = useDebouncedCallback(
    (value: string) => setDebouncedQuery(value),
    200,
  );

  const { data: results = [] } = useQuery({
    queryKey: ["contacts", "search", debouncedQuery, type],
    queryFn: () => searchContacts(debouncedQuery, type),
    enabled: debouncedQuery.length > 0,
  });

  const handleValueChange = (value: ContactResult | null) => {
    if (!value) {
      return;
    }

    if (
      value.id === CREATE_PERSON_SENTINEL.id ||
      value.id === CREATE_ORG_SENTINEL.id
    ) {
      onCreate?.(
        query.trim(),
        value.id === CREATE_PERSON_SENTINEL.id ? "person" : "organization",
      );
      setQuery("");
      setDebouncedQuery("");
      return;
    }

    onSelect(value);
    setQuery("");
    setDebouncedQuery("");
  };

  const showCreate = onCreate && query.trim().length > 0;

  return (
    <Combobox<ContactResult>
      itemToStringLabel={(option) => option.displayName}
      onInputValueChange={(inputValue) => {
        setQuery(inputValue);
        debouncedSetQuery(inputValue);
      }}
      onValueChange={handleValueChange}
      value={null}
    >
      <ComboboxInput
        autoFocus={autoFocus}
        placeholder={placeholder ?? t("workspaces.parties.searchContacts")}
        showTrigger={false}
        startAddon={<SearchIcon />}
        value={query}
      />
      <ComboboxPopup>
        <ComboboxList>
          {results.map((contact) => (
            <ComboboxItem key={contact.id} value={contact}>
              <div className="flex items-center gap-2">
                {contact.type === "person" ? (
                  <UserIcon className="text-muted-foreground size-3.5" />
                ) : (
                  <BuildingIcon className="text-muted-foreground size-3.5" />
                )}
                <span>{contact.displayName}</span>
              </div>
            </ComboboxItem>
          ))}
          {showCreate && (
            <>
              {(!type || type === "organization") && (
                <ComboboxItem
                  value={{
                    ...CREATE_ORG_SENTINEL,
                    displayName: query.trim(),
                  }}
                >
                  <div className="text-primary flex items-center gap-2">
                    <PlusIcon className="size-3.5" />
                    <span>
                      {t("contacts.createOrganization", {
                        name: query.trim(),
                      })}
                    </span>
                  </div>
                </ComboboxItem>
              )}
              {(!type || type === "person") && (
                <ComboboxItem
                  value={{
                    ...CREATE_PERSON_SENTINEL,
                    displayName: query.trim(),
                  }}
                >
                  <div className="text-primary flex items-center gap-2">
                    <PlusIcon className="size-3.5" />
                    <span>
                      {t("contacts.createPerson", {
                        name: query.trim(),
                      })}
                    </span>
                  </div>
                </ComboboxItem>
              )}
            </>
          )}
        </ComboboxList>
        {!showCreate && (
          <ComboboxEmpty>
            {query.length > 0
              ? t("contacts.noContactsFound")
              : t("workspaces.parties.searchContacts")}
          </ComboboxEmpty>
        )}
      </ComboboxPopup>
    </Combobox>
  );
};
