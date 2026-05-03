import { useEffect, useState } from "react";

import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@stll/ui/components/input-group";
import { getRouteApi } from "@tanstack/react-router";
import { SearchIcon } from "lucide-react";
import { useDebouncedCallback } from "use-debounce";
import { useTranslations } from "use-intl";

import { InviteMemberDialog } from "@/routes/_protected.organization/-components/invite-member-dialog";

const settingsOrgParentRoute = getRouteApi("/_protected/settings/organization");
const membersRoute = getRouteApi("/_protected/settings/organization/members");

export const OrganizationListToolbar = () => {
  const t = useTranslations();
  // Search lives on the parent route so it survives sub-tab swaps;
  // navigate must target the leaf so we don't pull the user up to
  // the parent (which has no index and would render blank).
  const q = settingsOrgParentRoute.useSearch({ select: (s) => s.q });
  const navigate = membersRoute.useNavigate();
  const [localQuery, setLocalQuery] = useState(() => q ?? "");

  useEffect(() => {
    setLocalQuery(q ?? "");
  }, [q]);

  const updateSearch = useDebouncedCallback((value: string) => {
    // eslint-disable-next-line typescript/no-floating-promises
    navigate({
      to: "/settings/organization/members",
      search: (prev) => ({ ...prev, q: value || undefined }),
    });
  }, 300);

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
