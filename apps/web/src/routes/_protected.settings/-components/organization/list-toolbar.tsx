import { useState } from "react";

import { getRouteApi } from "@tanstack/react-router";
import { SearchIcon } from "lucide-react";
import { useDebouncedCallback } from "use-debounce";
import { useTranslations } from "use-intl";

import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@stll/ui/components/input-group";

import { InviteMemberDialog } from "@/routes/_protected.organization/-components/invite-member-dialog";

const settingsOrgParentRoute = getRouteApi("/_protected/settings/organization");
const membersRoute = getRouteApi("/_protected/settings/organization/members");

/**
 * One-shot marker for the value the debounced writer last pushed up, so the
 * resync-during-render branch can tell that write's echo apart from external
 * navigation. Wrapped in an object because `undefined` is itself a legitimate
 * written value (a cleared field); `null` means "no unconsumed write".
 */
type WrittenMarker = { value: string | undefined } | null;

export const OrganizationListToolbar = () => {
  const t = useTranslations();
  // Search lives on the parent route so it survives sub-tab swaps;
  // navigate must target the leaf so we don't pull the user up to
  // the parent (which has no index and would render blank).
  const q = settingsOrgParentRoute.useSearch({ select: (s) => s.q ?? "" });
  const navigate = membersRoute.useNavigate();
  // Local controlled-input value keeps IME composition snappy and
  // prevents flicker between keystrokes; the URL is the source of
  // truth and gets the trimmed value via the debounced writer.
  const [localQuery, setLocalQuery] = useState(q);
  const [lastSeenUrlQuery, setLastSeenUrlQuery] = useState(q);
  const [lastWrittenQuery, setLastWrittenQuery] = useState<WrittenMarker>(null);
  const updateSearch = useDebouncedCallback((value: string) => {
    // Marker must match what the navigate search updater stores: empty becomes undefined.
    setLastWrittenQuery({ value: value || undefined });
    void navigate({
      to: "/settings/organization/members",
      search: (prev) => ({ ...prev, q: value || undefined }),
    });
  }, 300);

  // Adjusting state during render: when the URL `q` changes to a value our
  // local mirror has not seen, decide echo vs. external change. The echo of
  // our own debounced write must NOT cancel or reset local state: the user
  // may have resumed typing during the navigate round-trip, and a reset
  // would drop those keystrokes plus their newly-scheduled debounced write.
  // Only a genuinely external change (back/forward navigation, tab switches
  // landing on a different `?q=`) replaces the input. The marker is
  // consumed on every transition so a stale one cannot misclassify a later
  // external change as an echo. `q` normalizes a missing param to "", so the
  // marker's value gets the same normalization before comparing.
  if (q !== lastSeenUrlQuery) {
    setLastSeenUrlQuery(q);
    setLastWrittenQuery(null);
    if (lastWrittenQuery === null || (lastWrittenQuery.value ?? "") !== q) {
      updateSearch.cancel();
      setLocalQuery(q);
    }
  }

  return (
    <div className="border-border/60 flex items-center gap-2 border-b px-2 py-2">
      <InputGroup className="max-w-sm flex-1">
        <InputGroupInput
          onChange={(e) => {
            const val = e.target.value;
            setLocalQuery(val);
            updateSearch(val);
          }}
          placeholder={t("common.search")}
          value={localQuery}
        />
        <InputGroupAddon>
          <SearchIcon />
        </InputGroupAddon>
      </InputGroup>
      <InviteMemberDialog />
    </div>
  );
};
