import type { ReactNode } from "react";

import { ListItemSkeleton } from "@stll/ui/list-shell";
import { SettingsSection } from "@stll/ui/settings";

import { PendingText } from "@/components/pending-text";

/** The sign-in methods section's anchor; the summary and next steps link it. */
export const SIGN_IN_METHODS_SECTION_ID = "sign-in-methods";

/** The sign-in methods' section: its heading over one row per method. */
export const SignInMethodsGroup = ({ children }: { children: ReactNode }) => (
  <SettingsSection
    className="scroll-mt-6"
    description={
      <PendingText
        barClassName="w-72 max-w-full"
        id="settings.account.signInMethods.description"
      />
    }
    id={SIGN_IN_METHODS_SECTION_ID}
    title={
      <PendingText
        barClassName="w-28"
        id="settings.account.signInMethods.title"
      />
    }
  >
    {children}
  </SettingsSection>
);

/** Placeholder rows while the methods load: the email code and one account. */
const SIGN_IN_METHOD_ROWS_PENDING = [{ key: "a" }, { key: "b" }] as const;

/** The methods while they load, at the rows' geometry. */
export const SignInMethodsRowsPending = () =>
  SIGN_IN_METHOD_ROWS_PENDING.map((row, index) => (
    <ListItemSkeleton index={index} key={row.key} media />
  ));

/** The sign-in methods in their pending phase. */
export const SignInMethodsPending = () => (
  <SignInMethodsGroup>
    <SignInMethodsRowsPending />
  </SignInMethodsGroup>
);
