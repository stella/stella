import { createContext, use, useEffect, useState } from "react";

import { Result } from "better-result";

import type { PermissionInput } from "@stll/permissions/role-grants";

import type { AccessTokenSource } from "@/connection/session";
import { useSession } from "@/connection/session-provider";
import { readMyRole, roleCan } from "@/state/role";

const RoleContext = createContext<string | null>(null);

/**
 * The signed-in person's role, read once per sign-in, for every screen to
 * decide what it offers. Until it is read, and if it cannot be, nothing that
 * needs a permission is offered, as the web does while its role loads.
 */
export const RoleProvider = ({ children }: React.PropsWithChildren) => {
  const { state } = useSession();
  const source = state.status === "signed-in" ? state.source : null;
  const [read, setRead] = useState<{
    readonly source: AccessTokenSource;
    readonly role: string;
  } | null>(null);

  useEffect(() => {
    if (source === null) {
      return;
    }
    let current = true;
    void (async () => {
      const role = await readMyRole({ fetch, source });
      if (current && Result.isOk(role)) {
        setRead({ source, role: role.value });
      }
    })();
    return () => {
      current = false;
    };
  }, [source]);

  // A role read for an earlier sign-in says nothing of this one.
  const role = read !== null && read.source === source ? read.role : null;
  return <RoleContext value={role}>{children}</RoleContext>;
};

/** Whether the person's role allows `permissions`; false until it is read. */
export const useCan = (permissions: PermissionInput): boolean =>
  roleCan(use(RoleContext), permissions);
