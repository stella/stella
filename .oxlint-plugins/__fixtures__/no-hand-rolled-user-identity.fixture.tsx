declare const user: { name: string; image: string | null };
declare const otherUser: { name: string };
declare const UserIdentityAvatar: (props: {
  name: string;
  image?: string | null;
}) => unknown;
declare const UserIdentity: (props: {
  name: string;
  image?: string | null;
}) => unknown;
declare const Tooltip: (props: { children: unknown }) => unknown;
declare const TooltipRoot: (props: { children: unknown }) => unknown;
declare const TooltipTrigger: (props: { children: unknown }) => unknown;
declare const TooltipPopup: (props: { children: unknown }) => unknown;

// An avatar beside the exact same raw name must use UserIdentity.
const _handRolled = (
  <span>
    {/* oxlint-disable-next-line no-hand-rolled-user-identity/no-hand-rolled-user-identity */}
    <UserIdentityAvatar image={user.image} name={user.name} />
    <span>{user.name}</span>
  </span>
);

// Wrapping the avatar must not hide the paired raw-name sibling.
const _wrappedHandRolled = (
  <span>
    <Tooltip>
      {/* oxlint-disable-next-line no-hand-rolled-user-identity/no-hand-rolled-user-identity */}
      <UserIdentityAvatar image={user.image} name={user.name} />
    </Tooltip>
    <span>{user.name}</span>
  </span>
);

// Shared identity, avatar-only, transformed, and different-name variants stay valid.
// expect-clean: no-hand-rolled-user-identity/no-hand-rolled-user-identity
const _shared = <UserIdentity image={user.image} name={user.name} />;
const _avatarOnly = <UserIdentityAvatar image={user.image} name={user.name} />;
const _transformed = (
  <span>
    <UserIdentityAvatar name={user.name} />
    <span>{user.name.toUpperCase()}</span>
  </span>
);
const _differentName = (
  <span>
    <UserIdentityAvatar name={user.name} />
    <span>{otherUser.name}</span>
  </span>
);
const _tooltipOnlyLabel = (
  <TooltipRoot>
    <TooltipTrigger>
      <UserIdentityAvatar image={user.image} name={user.name} />
    </TooltipTrigger>
    <TooltipPopup>{user.name}</TooltipPopup>
  </TooltipRoot>
);

export const __noHandRolledUserIdentityFixture = {
  _handRolled,
  _wrappedHandRolled,
  _shared,
  _avatarOnly,
  _transformed,
  _differentName,
  _tooltipOnlyLabel,
};
