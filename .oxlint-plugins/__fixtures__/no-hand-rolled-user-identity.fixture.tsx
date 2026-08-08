declare const user: { name: string; image: string | null };
declare const otherUser: { name: string };
declare const UserAvatar: (props: {
  name: string;
  image?: string | null;
}) => unknown;
declare const UserIdentity: (props: {
  name: string;
  image?: string | null;
}) => unknown;

// An avatar beside the exact same raw name must use UserIdentity.
const _handRolled = (
  <span>
    {/* oxlint-disable-next-line no-hand-rolled-user-identity/no-hand-rolled-user-identity */}
    <UserAvatar image={user.image} name={user.name} />
    <span>{user.name}</span>
  </span>
);

// Shared identity, avatar-only, transformed, and different-name variants stay valid.
const _shared = <UserIdentity image={user.image} name={user.name} />;
const _avatarOnly = <UserAvatar image={user.image} name={user.name} />;
const _transformed = (
  <span>
    <UserAvatar name={user.name} />
    <span>{user.name.toUpperCase()}</span>
  </span>
);
const _differentName = (
  <span>
    <UserAvatar name={user.name} />
    <span>{otherUser.name}</span>
  </span>
);

export const __noHandRolledUserIdentityFixture = {
  _handRolled,
  _shared,
  _avatarOnly,
  _transformed,
  _differentName,
};
