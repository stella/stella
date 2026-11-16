// Passive regression fixture for `no-person-select/no-person-select`.
//
// `oxlint-disable-next-line` directives suppress cases the rule MUST flag; if
// the rule regresses the directive goes unused and
// `--report-unused-disable-directives-severity=error` fails CI. Lines without a
// directive cover the allow-list and must keep passing.

import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
  Select as StSelect,
  SelectItem as StSelectItem,
} from "@stll/ui/select";

import { UserIdentity, UserIdentityAvatar } from "@/components/user-avatar";

const members = [{ userId: "u1", name: "Eva Dvořák" }];
const memberships: { user: { id: string; name: string } | null }[] = [];
const languages = ["cs", "en"];

// --- Flagged: items valued by a user id ---
export const _a = () => (
  // oxlint-disable-next-line no-person-select/no-person-select
  <Select>
    <SelectTrigger>
      <SelectValue />
    </SelectTrigger>
    <SelectPopup>
      {members.map((member) => (
        <SelectItem key={member.userId} value={member.userId}>
          {member.name}
        </SelectItem>
      ))}
    </SelectPopup>
  </Select>
);
export const _b = () => (
  // oxlint-disable-next-line no-person-select/no-person-select
  <Select>
    <SelectPopup>
      {memberships.map((m) => (
        <SelectItem key={m.user?.id} value={m.user?.id}>
          {m.user?.name}
        </SelectItem>
      ))}
    </SelectPopup>
  </Select>
);
// Flagged: a user identity rendered anywhere under the Select, including a
// value render callback.
export const _c = () => (
  // oxlint-disable-next-line no-person-select/no-person-select
  <Select>
    <SelectTrigger>
      <SelectValue>{() => <UserIdentityAvatar name="Eva" />}</SelectValue>
    </SelectTrigger>
    <SelectPopup>
      {members.map((member) => (
        <SelectItem key={member.userId} value={member}>
          <UserIdentity name={member.name} />
        </SelectItem>
      ))}
    </SelectPopup>
  </Select>
);
// Flagged: aliased imports resolve to the same components.
export const _d = () => (
  // oxlint-disable-next-line no-person-select/no-person-select
  <StSelect>
    {members.map((member) => (
      <StSelectItem key={member.userId} value={member.userId}>
        {member.name}
      </StSelectItem>
    ))}
  </StSelect>
);

// --- Allowed: a Select over anything that is not a person ---
// expect-clean: no-person-select/no-person-select
export const _ok1 = () => (
  <Select>
    <SelectPopup>
      {languages.map((code) => (
        <SelectItem key={code} value={code}>
          {code}
        </SelectItem>
      ))}
    </SelectPopup>
  </Select>
);
// A user identity beside a Select, not inside it.
export const _ok2 = () => (
  <div>
    <UserIdentityAvatar name="Eva" />
    <Select>
      <SelectItem value="all-markup">All markup</SelectItem>
    </Select>
  </div>
);
