import type { ReactNode } from "react";

import {
  List,
  ListGroup,
  ListGroupDescription,
  ListGroupHeader,
  ListGroupHeading,
  ListGroupTitle,
  ListItemSkeleton,
} from "@stll/ui/list-shell";

import { PendingText } from "@/components/pending-text";

/** The sign-in methods' group: its heading over the methods (`SignInMethods`). */
export const SignInMethodsGroup = ({ children }: { children: ReactNode }) => (
  <ListGroup>
    <ListGroupHeader>
      <ListGroupHeading>
        <ListGroupTitle>
          <PendingText
            barClassName="w-28"
            id="settings.account.signInMethods.title"
          />
        </ListGroupTitle>
        <ListGroupDescription>
          <PendingText
            barClassName="w-72 max-w-full"
            id="settings.account.signInMethods.description"
          />
        </ListGroupDescription>
      </ListGroupHeading>
    </ListGroupHeader>
    {children}
  </ListGroup>
);

/** Placeholder rows while the methods load: the email code and one account. */
const SIGN_IN_METHOD_ROWS_PENDING = [{ key: "a" }, { key: "b" }] as const;

/** The methods while they load, at the rows' geometry. */
export const SignInMethodsRowsPending = () => (
  <List aria-hidden="true">
    {SIGN_IN_METHOD_ROWS_PENDING.map((row, index) => (
      <ListItemSkeleton index={index} key={row.key} />
    ))}
  </List>
);

/** The sign-in methods in their pending phase. */
export const SignInMethodsPending = () => (
  <SignInMethodsGroup>
    <SignInMethodsRowsPending />
  </SignInMethodsGroup>
);
