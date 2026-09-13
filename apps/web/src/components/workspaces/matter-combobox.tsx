import { useDeferredValue, useState } from "react";

import { useQuery } from "@tanstack/react-query";
import { SearchIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { BidiText } from "@stll/ui/bidi-text";
import { Button } from "@stll/ui/button";
import {
  Combobox,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
} from "@stll/ui/combobox";

import { detached } from "@/lib/detached";
import { workspacesNavigationOptions } from "@/lib/workspaces/queries";

export type MatterOption = {
  id: string;
  name: string;
  clientName: string | null;
};

const EMPTY_MATTERS: MatterOption[] = [];

type MatterComboboxProps = {
  /**
   * Whose matters to offer. Passed in rather than read from the authenticated
   * user context: the public case-law page has no such context and still opens
   * this control once a reader is signed in.
   */
  activeOrganizationId: string;
  /** The control's id, so a label outside it can point at the field. */
  id: string;
  onChange: (matter: MatterOption | null) => void;
  value: MatterOption | null;
};

/**
 * Which matter an action lands in.
 *
 * One control wherever the app asks that question — uploading a document,
 * pinning case law — so the list, the search and the client line read the same
 * everywhere. Filtering is client-side over the navigation list the sidebar
 * already holds, so the popup opens without a round trip.
 */
export const MatterCombobox = ({
  activeOrganizationId,
  id,
  onChange,
  value,
}: MatterComboboxProps) => {
  const t = useTranslations();
  const [search, setSearch] = useState("");
  const deferredSearch = useDeferredValue(search);
  const {
    data: matters = EMPTY_MATTERS,
    error,
    isPending,
    refetch,
  } = useQuery({
    ...workspacesNavigationOptions(activeOrganizationId),
    select: (data) =>
      data.workspaces.map((matter) => ({
        clientName: matter.client?.displayName ?? null,
        id: matter.id,
        name: matter.name,
      })),
  });

  const term = deferredSearch.trim().toLocaleLowerCase();
  const filtered = matters.filter(
    (matter) =>
      term.length === 0 ||
      matter.name.toLocaleLowerCase().includes(term) ||
      matter.clientName?.toLocaleLowerCase().includes(term),
  );

  return (
    <div className="flex flex-col gap-2">
      <Combobox
        itemToStringLabel={(matter) => matter.name}
        onInputValueChange={setSearch}
        onValueChange={(matter) => onChange(matter)}
        value={value}
      >
        <ComboboxInput
          id={id}
          placeholder={t("common.selectAMatter")}
          showClear={search.length > 0}
          startAddon={<SearchIcon />}
          value={search}
        />
        <ComboboxPopup>
          <ComboboxList>
            {filtered.map((matter) => (
              <ComboboxItem key={matter.id} value={matter}>
                <BidiText className="truncate">{matter.name}</BidiText>
                {matter.clientName !== null && (
                  <span className="text-muted-foreground ms-2 truncate text-xs">
                    <BidiText>{matter.clientName}</BidiText>
                  </span>
                )}
              </ComboboxItem>
            ))}
          </ComboboxList>
          <ComboboxEmpty>{t("common.noResults")}</ComboboxEmpty>
        </ComboboxPopup>
      </Combobox>
      {isPending && (
        <p className="text-muted-foreground text-sm">{t("common.loading")}</p>
      )}
      {error !== null && (
        <div className="flex items-center justify-between gap-2 text-sm">
          <span className="text-destructive">{t("errors.actionFailed")}</span>
          <Button
            onClick={() => detached(refetch(), "matter-combobox.retry")}
            size="xs"
            variant="ghost"
          >
            {t("common.retry")}
          </Button>
        </div>
      )}
    </div>
  );
};
