import { useState } from "react";
import type * as React from "react";

import { useQuery } from "@tanstack/react-query";
import { panic } from "better-result";
import { useDebouncedCallback } from "use-debounce";
import { useTranslations } from "use-intl";

import type { ContactType } from "@stll/api-contract";
import { BidiText } from "@stll/ui/bidi-text";
import {
  Combobox,
  ComboboxEmpty,
  ComboboxGroup,
  ComboboxGroupLabel,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
} from "@stll/ui/combobox";
import { BuildingIcon, PlusIcon, SearchIcon, UserIcon } from "@stll/ui/icons";

import { contactPickerSearchOptions } from "@/components/contact-picker-queries";
import { rankRecentClients } from "@/components/contact-picker.logic";
import { ContactReadError } from "@/components/contact-read-error";
import { useFormatter } from "@/i18n/formatting-context";
import { useAuthenticatedUser } from "@/lib/authenticated-user-context";
import { detached } from "@/lib/detached";
import { useQueryView } from "@/lib/use-query-view";
import {
  type WorkspacesData,
  workspacesRouteOptions,
} from "@/lib/workspaces/queries";

type ContactResult = {
  id: string;
  type: ContactType;
  displayName: string;
};

/** Sentinel value indicating the user wants to create a new contact. */
const CREATE_PERSON_SENTINEL: ContactResult = {
  id: "__create_person__",
  type: "person",
  displayName: "",
};

const CREATE_ORG_SENTINEL: ContactResult = {
  id: "__create_org__",
  type: "organization",
  displayName: "",
};

/** What the picker lists before anything is typed. */
export const CONTACT_PICKER_SUGGESTIONS = {
  /** The organization's clients, most recently active first. */
  recentClients: "recentClients",
} as const;

type ContactPickerSuggestions =
  (typeof CONTACT_PICKER_SUGGESTIONS)[keyof typeof CONTACT_PICKER_SUGGESTIONS];

const selectRecentClients = ({ workspaces }: WorkspacesData) =>
  rankRecentClients(workspaces);

type ContactOptionLabelProps = {
  contact: ContactResult;
  children?: React.ReactNode;
};

const ContactOptionLabel = ({ contact, children }: ContactOptionLabelProps) => (
  <div className="flex items-center gap-2">
    {contact.type === "person" ? (
      <UserIcon className="text-muted-foreground size-3.5" />
    ) : (
      <BuildingIcon className="text-muted-foreground size-3.5" />
    )}
    <BidiText>{contact.displayName}</BidiText>
    {children}
  </div>
);

type ContactPickerProps = {
  onSelect: (contact: ContactResult) => void;
  /** Called when the user wants to create a new contact inline. */
  onCreate?: (name: string, type: ContactType) => void;
  type?: ContactType | undefined;
  placeholder?: string;
  autoFocus?: boolean;
  invalid?: boolean;
  inputRef?: React.Ref<HTMLInputElement>;
  /** Options listed while the query is empty; none by default. */
  suggestions?: ContactPickerSuggestions;
};

export const ContactPicker = ({
  onSelect,
  onCreate,
  type,
  placeholder,
  autoFocus,
  invalid = false,
  inputRef,
  suggestions,
}: ContactPickerProps) => {
  const t = useTranslations();
  const format = useFormatter();
  const activeOrganizationId = useAuthenticatedUser().activeOrganizationId;
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");

  const debouncedSetQuery = useDebouncedCallback(
    (value: string) => setDebouncedQuery(value),
    200,
  );

  const view = useQueryView(
    useQuery({
      ...contactPickerSearchOptions({
        organizationId: activeOrganizationId,
        q: debouncedQuery,
        type,
      }),
      enabled: debouncedQuery.length > 0,
    }),
  );
  const results = (() => {
    switch (view.type) {
      case "items":
        return view.items;
      case "pending":
      case "error":
      case "empty":
        return [];
      default:
        view satisfies never;
        return panic("Unhandled contact picker query state");
    }
  })();

  // The org's matter list (one cached query, also read by the matters page
  // and the create-matter dialog) carries each matter's client and activity,
  // so ranking and counting clients reuses it instead of a dedicated read.
  const suggestsRecentClients =
    suggestions === CONTACT_PICKER_SUGGESTIONS.recentClients;
  const suggestionView = useQueryView(
    useQuery({
      ...workspacesRouteOptions(activeOrganizationId),
      select: selectRecentClients,
      enabled: suggestsRecentClients,
    }),
  );
  const suggestedClients = (() => {
    switch (suggestionView.type) {
      case "items":
        return suggestionView.items;
      case "pending":
      case "error":
      case "empty":
        return [];
      default:
        suggestionView satisfies never;
        return panic("Unhandled contact picker suggestion state");
    }
  })();
  const showSuggestions = suggestsRecentClients && query.length === 0;

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

  const showCreate =
    onCreate &&
    query.trim().length > 0 &&
    query === debouncedQuery &&
    (view.type === "empty" ||
      (view.type === "items" && view.refetchError === undefined));
  const createOptions: ContactResult[] = [];
  if (showCreate && (!type || type === "organization")) {
    createOptions.push({ ...CREATE_ORG_SENTINEL, displayName: query.trim() });
  }
  if (showCreate && (!type || type === "person")) {
    createOptions.push({
      ...CREATE_PERSON_SENTINEL,
      displayName: query.trim(),
    });
  }
  const items = showSuggestions
    ? suggestedClients
    : [...results, ...createOptions];

  const searchStatus = (() => {
    switch (view.type) {
      case "pending":
        return (
          <p className="text-muted-foreground p-3 text-sm" role="status">
            {t(
              query.length > 0
                ? "common.loading"
                : "workspaces.parties.searchContacts",
            )}
          </p>
        );
      case "error":
        return (
          <ContactReadError
            error={view.error}
            onRetry={() => detached(view.retry(), "contact-picker.retry")}
          />
        );
      case "empty":
        return <ComboboxEmpty>{t("contacts.noContactsFound")}</ComboboxEmpty>;
      case "items":
        return view.refetchError !== undefined ? (
          <ContactReadError
            error={view.refetchError}
            onRetry={() => detached(view.retry(), "contact-picker.retry")}
          />
        ) : null;
      default:
        view satisfies never;
        return panic("Unhandled contact picker query state");
    }
  })();

  const retrySuggestions = () =>
    detached(suggestionView.retry(), "contact-picker.suggestions-retry");
  const suggestionStatus = (() => {
    switch (suggestionView.type) {
      case "pending":
        return (
          <p className="text-muted-foreground p-3 text-sm" role="status">
            {t("common.loading")}
          </p>
        );
      case "error":
        return (
          <ContactReadError
            error={suggestionView.error}
            onRetry={retrySuggestions}
          />
        );
      case "empty":
        // No client yet: read as the picker does without suggestions.
        return (
          <p className="text-muted-foreground p-3 text-sm" role="status">
            {t("workspaces.parties.searchContacts")}
          </p>
        );
      case "items":
        return suggestionView.refetchError !== undefined ? (
          <ContactReadError
            error={suggestionView.refetchError}
            onRetry={retrySuggestions}
          />
        ) : null;
      default:
        suggestionView satisfies never;
        return panic("Unhandled contact picker suggestion state");
    }
  })();

  return (
    <Combobox<ContactResult>
      // The server already filters by `q`; without `items` Base UI's
      // filtered list stays empty and ComboboxEmpty renders permanently.
      filter={null}
      items={items}
      itemToStringLabel={(option) => option.displayName}
      onInputValueChange={(inputValue) => {
        setQuery(inputValue);
        debouncedSetQuery(inputValue);
      }}
      onValueChange={handleValueChange}
      value={null}
    >
      <ComboboxInput
        aria-invalid={invalid}
        autoFocus={autoFocus}
        placeholder={placeholder ?? t("workspaces.parties.searchContacts")}
        ref={inputRef ?? null}
        showTrigger={false}
        startAddon={<SearchIcon />}
        value={query}
      />
      <ComboboxPopup>
        <ComboboxList>
          {showSuggestions ? (
            suggestedClients.length > 0 && (
              <ComboboxGroup>
                <ComboboxGroupLabel>
                  {t("workspaces.parties.recentClients")}
                </ComboboxGroupLabel>
                {suggestedClients.map((client) => (
                  <ComboboxItem key={client.id} value={client}>
                    <ContactOptionLabel contact={client}>
                      <span
                        aria-hidden
                        className="text-muted-foreground ms-auto text-xs tabular-nums"
                      >
                        {format.number(client.matterCount)}
                      </span>
                      <span className="sr-only">
                        {t("workspaces.mattersCount", {
                          count: client.matterCount,
                        })}
                      </span>
                    </ContactOptionLabel>
                  </ComboboxItem>
                ))}
              </ComboboxGroup>
            )
          ) : (
            <>
              {results.map((contact) => (
                <ComboboxItem key={contact.id} value={contact}>
                  <ContactOptionLabel contact={contact} />
                </ComboboxItem>
              ))}
              {createOptions.map((option) => (
                <ComboboxItem key={option.id} value={option}>
                  <div className="text-primary flex items-center gap-2">
                    <PlusIcon className="size-3.5" />
                    <span>
                      {option.type === "organization"
                        ? t("contacts.createOrganization", {
                            name: option.displayName,
                          })
                        : t("contacts.createPerson", {
                            name: option.displayName,
                          })}
                    </span>
                  </div>
                </ComboboxItem>
              ))}
            </>
          )}
        </ComboboxList>
        {showSuggestions ? suggestionStatus : searchStatus}
      </ComboboxPopup>
    </Combobox>
  );
};
