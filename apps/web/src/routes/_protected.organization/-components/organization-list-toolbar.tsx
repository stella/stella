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

const organizationRoute = getRouteApi("/_protected/organization");

export const OrganizationListToolbar = () => {
  const t = useTranslations();
  const q = organizationRoute.useSearch({ select: (s) => s.q });
  const navigate = organizationRoute.useNavigate();
  const [localQuery, setLocalQuery] = useState(() => q ?? "");

  useEffect(() => {
    setLocalQuery(q ?? "");
  }, [q]);

  const updateSearch = useDebouncedCallback((value: string) => {
    // eslint-disable-next-line typescript/no-floating-promises
    navigate({
      search: (prev) => ({ ...prev, q: value || undefined }),
    });
  }, 300);

  return (
    <div className="flex items-center gap-2">
      <InputGroup className="me-auto max-w-sm flex-1">
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
