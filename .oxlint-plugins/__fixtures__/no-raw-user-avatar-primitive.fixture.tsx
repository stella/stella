// Importing the raw primitive for a user identity must be rejected.
// oxlint-disable-next-line no-raw-user-avatar-primitive/no-raw-user-avatar-primitive
import { Avatar } from "@stll/ui/components/avatar";

// Shared identity components and unrelated avatar modules stay valid.
import { UserAvatar, UserIdentity } from "@/components/user-avatar";

import { OrganizationAvatar } from "./organization-avatar";

export const RawUserAvatarPrimitiveFixture = () => (
  <>
    <Avatar />
    <UserAvatar name="Ada Lovelace" />
    <UserIdentity name="Ada Lovelace" />
    <OrganizationAvatar />
  </>
);
