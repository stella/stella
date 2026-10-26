import { useMemo, useState } from "react";

import { panic } from "better-result";
import { useTranslations } from "use-intl";

import { compareByLocale } from "@stll/collation";
import {
  Combobox,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
  useComboboxFilter,
} from "@stll/ui/combobox";
import { SearchIcon } from "@stll/ui/icons";

import { UserIdentity, UserIdentityAvatar } from "@/components/user-avatar";
import { useLocale } from "@/i18n/formatting-context";
import { getDisplayName } from "@/lib/get-display-name";

/** A person the picker offers. */
export type MemberOption = {
  userId: string;
  name: string;
  email: string | null;
  image: string | null;
};

type WorkspaceMember = {
  userId: string;
  user: {
    email: string;
    image: string | null;
    name: string;
  } | null;
};

/**
 * A matter's members as picker options. A membership whose account is gone
 * (`user` is null) has no name to find it by, so it is not offered.
 */
export const workspaceMemberOptions = (
  members: readonly WorkspaceMember[],
): MemberOption[] =>
  members.flatMap(({ userId, user }) =>
    user === null
      ? []
      : [{ userId, name: user.name, email: user.email, image: user.image }],
  );

export const MEMBER_CHOICE = {
  /** The list offers members only. */
  member: "member",
  /** The list leads with a row that chooses nobody (unassigned, default). */
  memberOrNone: "memberOrNone",
} as const;

type MemberChoice =
  | { type: typeof MEMBER_CHOICE.member }
  | { type: typeof MEMBER_CHOICE.memberOrNone; noneLabel: string };

type MemberComboboxItem =
  | { type: "member"; key: string; label: string; member: MemberOption }
  | { type: "none"; key: string; label: string };

const NONE_KEY = "__none__";

type MemberComboboxProps = {
  /** The accessible name; the visible label, when the field has one. */
  label: string;
  /** Lets a label outside the control point at the field. */
  id?: string | undefined;
  members: readonly MemberOption[];
  /** The chosen member's user id, or null for nobody. */
  value: string | null;
  onValueChange: (userId: string | null) => void;
  placeholder: string;
  choice: MemberChoice;
  /** Members listed but not choosable, with the reason shown on their row. */
  unavailable?: { userIds: ReadonlySet<string>; reason: string } | undefined;
  /**
   * The chosen member when it is missing from `members` (a contact's owner
   * who has since left the organization), so the field still names them.
   */
  selectedFallback?: MemberOption | null | undefined;
  disabled?: boolean | undefined;
  autoFocus?: boolean | undefined;
  /**
   * Enter on the closed list, once a member is chosen. A dialog passes its
   * submit so the first Enter picks the highlighted member and the second
   * confirms.
   */
  onSubmit?: (() => void) | undefined;
};

/**
 * Which person an action applies to.
 *
 * One control wherever the app asks for a person (matter lead, assignee, new
 * matter member, contact owner, rate holder), so typing finds someone the
 * same way everywhere: by name or email, accent- and case-insensitively.
 * Filtering is client-side over the member list the caller already reads.
 * Emptying the input to search again never clears the choice on its own;
 * only the "nobody" row does, where the field offers one.
 */
export const MemberCombobox = ({
  label,
  id,
  members,
  value,
  onValueChange,
  placeholder,
  choice,
  unavailable,
  selectedFallback,
  disabled,
  autoFocus,
  onSubmit,
}: MemberComboboxProps) => {
  const t = useTranslations();
  const locale = useLocale();
  const [open, setOpen] = useState(false);
  const unknownUser = t("common.unknownUser");
  const noneLabel =
    choice.type === MEMBER_CHOICE.memberOrNone ? choice.noneLabel : null;

  // Base UI copies `items` into its own state whenever the prop's identity
  // changes, so the list is rebuilt only when its inputs change.
  const items = useMemo(() => {
    const compareNames = compareByLocale(locale);
    const memberItems = members
      .map((member): MemberComboboxItem => ({
        type: "member",
        key: member.userId,
        label: getDisplayName(member.name, member.email) ?? unknownUser,
        member,
      }))
      .toSorted((a, b) => compareNames(a.label, b.label));
    if (noneLabel === null) {
      return memberItems;
    }
    const none: MemberComboboxItem = {
      type: "none",
      key: NONE_KEY,
      label: noneLabel,
    };
    return [none, ...memberItems];
  }, [locale, members, noneLabel, unknownUser]);

  const selected = useMemo((): MemberComboboxItem | null => {
    if (value === null) {
      return null;
    }
    const listed = items.find((item) => item.key === value);
    if (listed !== undefined) {
      return listed;
    }
    if (selectedFallback?.userId !== value) {
      return null;
    }
    return {
      type: "member",
      key: selectedFallback.userId,
      label:
        getDisplayName(selectedFallback.name, selectedFallback.email) ??
        unknownUser,
      member: selectedFallback,
    };
  }, [items, selectedFallback, unknownUser, value]);

  const { contains } = useComboboxFilter({
    sensitivity: "base",
    value: selected,
  });

  const selectedMember = selected?.type === "member" ? selected.member : null;

  return (
    <Combobox
      disabled={disabled}
      filter={(item: MemberComboboxItem, query) => {
        switch (item.type) {
          case "none":
            return contains(item, query, itemLabel);
          case "member":
            return (
              contains(item, query, itemLabel) ||
              contains(item, query, itemEmail)
            );
          default:
            item satisfies never;
            return panic("Unhandled member picker item");
        }
      }}
      isItemEqualToValue={(item, current) => item.key === current.key}
      items={items}
      itemToStringLabel={itemLabel}
      onOpenChange={setOpen}
      onValueChange={(item, details) => {
        // Base UI drops the choice when the input is emptied; that is the
        // start of a new search, not a decision to choose nobody.
        if (item === null) {
          if (details.reason === "input-clear") {
            return;
          }
          onValueChange(null);
          return;
        }
        switch (item.type) {
          case "none":
            onValueChange(null);
            return;
          case "member":
            onValueChange(item.member.userId);
            return;
          default:
            item satisfies never;
            panic("Unhandled member picker item");
        }
      }}
      value={selected}
    >
      <ComboboxInput
        aria-label={label}
        autoFocus={autoFocus}
        id={id}
        onKeyDown={(event) => {
          if (
            event.key !== "Enter" ||
            open ||
            selectedMember === null ||
            onSubmit === undefined
          ) {
            return;
          }
          event.preventDefault();
          onSubmit();
        }}
        placeholder={placeholder}
        startAddon={
          selectedMember === null ? (
            <SearchIcon />
          ) : (
            <UserIdentityAvatar
              className="text-3xs size-5"
              image={selectedMember.image}
              name={getDisplayName(selectedMember.name, selectedMember.email)}
            />
          )
        }
      />
      <ComboboxPopup>
        <ComboboxList>
          {(item: MemberComboboxItem) => {
            switch (item.type) {
              case "none":
                return (
                  <ComboboxItem key={item.key} value={item}>
                    <span className="text-muted-foreground">{item.label}</span>
                  </ComboboxItem>
                );
              case "member": {
                const reason = unavailable?.userIds.has(item.key)
                  ? unavailable.reason
                  : null;
                return (
                  <ComboboxItem
                    disabled={reason !== null}
                    key={item.key}
                    value={item}
                  >
                    <div className="flex min-w-0 items-center gap-2">
                      <UserIdentity
                        as="span"
                        avatarClassName="size-6 shrink-0 text-3xs"
                        className="min-w-0 flex-1"
                        image={item.member.image}
                        name={item.member.name}
                        secondaryText={item.member.email}
                      />
                      {reason === null ? null : (
                        <span className="text-muted-foreground shrink-0 text-xs">
                          {reason}
                        </span>
                      )}
                    </div>
                  </ComboboxItem>
                );
              }
              default:
                item satisfies never;
                return panic("Unhandled member picker item");
            }
          }}
        </ComboboxList>
        <ComboboxEmpty>{t("common.noResults")}</ComboboxEmpty>
      </ComboboxPopup>
    </Combobox>
  );
};

function itemLabel(item: MemberComboboxItem): string {
  return item.label;
}

function itemEmail(item: MemberComboboxItem): string {
  return item.type === "member" ? (item.member.email ?? "") : "";
}
