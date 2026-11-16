import { Link } from "@tanstack/react-router";

import { IdentityText } from "@stll/ui/identity-text";

type ContactNameLinkProps = {
  contactId: string;
  displayName: string;
};

/** A contact's name in the contacts table, isolated from the cells around it. */
export const ContactNameLink = ({
  contactId,
  displayName,
}: ContactNameLinkProps) => (
  <Link
    className="block max-w-xs font-medium hover:underline"
    onClick={(event) => event.stopPropagation()}
    params={{ contactId }}
    to="/contacts/$contactId"
  >
    <IdentityText>{displayName}</IdentityText>
  </Link>
);
