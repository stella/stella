// Importing the raw primitive for a user identity must be rejected.
// oxlint-disable-next-line no-raw-user-avatar-primitive/no-raw-user-avatar-primitive
import { Avatar } from "@stll/ui/components/avatar";

// Shared identity components and unrelated avatar modules stay valid. These
// declarations keep the fixture independent of project module resolution.
declare const UserAvatar: (props: { name: string }) => unknown;
declare const UserIdentity: (props: { name: string }) => unknown;
declare const OrganizationAvatar: () => unknown;

export const RawUserAvatarPrimitiveFixture = () => (
  <>
    <Avatar />
    <UserAvatar name="Ada Lovelace" />
    <UserIdentity name="Ada Lovelace" />
    <OrganizationAvatar />
  </>
);
