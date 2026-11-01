import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, describe, expect, test } from "bun:test";

import { normalizeUnicode } from "@stll/text-normalize";

import { unregisterDomEnvironment } from "@/test-dom-environment";

GlobalRegistrator.register({ url: "http://localhost:3000/", width: 1280 });
// Assertions compare strings, never DOM nodes: a failing match on a node makes
// the runner print the whole document graph.

const testing = await import("@testing-library/react");
const { Profiler, useState } = await import("react");
const { panic } = await import("better-result");
const { IntlProvider } = await import("use-intl");
const { default: messages } = await import("@/i18n/langs/en.json");
const { FormattingProvider } = await import("@/i18n/formatting-context");
const { RenderLoopGuard } = await import("@/testing/render-loop-guard");
const { MEMBER_CHOICE, MemberCombobox } = await import("./member-combobox");

type MemberOption = Parameters<typeof MemberCombobox>[0]["members"][number];
type MemberChoice = Parameters<typeof MemberCombobox>[0]["choice"];

/** Commits the picker may take to settle; a list that never settles fails. */
const SETTLE_COMMITS = 10;

const DVORAK = {
  userId: "00000000-0000-7000-8000-0000000000a1",
  name: "Eva Dvořák",
  email: "eva@kancelar.example",
  image: null,
} satisfies MemberOption;
const HORAK = {
  userId: "00000000-0000-7000-8000-0000000000a2",
  name: "Tomáš Horák",
  email: "th@kancelar.example",
  image: null,
} satisfies MemberOption;
const NOVAKOVA = {
  userId: "00000000-0000-7000-8000-0000000000a3",
  name: "Petra Nováková",
  email: "petra.novakova@kancelar.example",
  image: null,
} satisfies MemberOption;
const MEMBERS = [NOVAKOVA, HORAK, DVORAK];

afterEach(() => {
  testing.cleanup();
});
afterAll(async () => {
  await unregisterDomEnvironment();
});

type RenderPickerOptions = {
  choice?: MemberChoice;
  initial?: string | null;
  members?: readonly MemberOption[];
  onCommit?: () => void;
  unavailable?: { userIds: ReadonlySet<string>; reason: string };
};

const renderPicker = ({
  choice = { type: MEMBER_CHOICE.member },
  initial = null,
  members = MEMBERS,
  onCommit = () => {},
  unavailable,
}: RenderPickerOptions = {}) => {
  const changes: (string | null)[] = [];
  let submits = 0;
  const Host = () => {
    const [value, setValue] = useState(initial);
    return (
      <MemberCombobox
        choice={choice}
        label="Member"
        // A copy on every render, as a caller mapping query data hands it.
        members={[...members]}
        onSubmit={() => {
          submits += 1;
        }}
        onValueChange={(userId) => {
          changes.push(userId);
          setValue(userId);
        }}
        placeholder={messages.common.searchMembers}
        unavailable={unavailable}
        value={value}
      />
    );
  };
  const ui = testing.render(
    <RenderLoopGuard>
      <IntlProvider locale="en" messages={messages} timeZone="UTC">
        <FormattingProvider locale="en" timeZone="UTC">
          <Profiler id="member-combobox" onRender={onCommit}>
            <Host />
          </Profiler>
        </FormattingProvider>
      </IntlProvider>
    </RenderLoopGuard>,
  );
  const input = ui.getByRole("combobox", { name: "Member" });
  if (!(input instanceof HTMLInputElement)) {
    throw new TypeError("Expected the member combobox input");
  }
  return { changes, input, submits: () => submits, ui };
};

const type = async (input: HTMLInputElement, value: string) => {
  await testing.act(async () => {
    input.focus();
    testing.fireEvent.input(input, {
      target: { value },
      inputType: "insertText",
    });
  });
};

const press = async (input: HTMLInputElement, key: string) => {
  await testing.act(async () => {
    testing.fireEvent.keyDown(input, { key });
  });
};

const optionLabels = (ui: ReturnType<typeof testing.render>) =>
  ui.queryAllByRole("option").map((option) => option.textContent);

describe("member combobox search", () => {
  test("finds a name typed without its accents or capitals", async () => {
    // The fixture must carry a letter that folding removes, or the search
    // would match byte for byte.
    expect(normalizeUnicode(DVORAK.name, "NFD")).not.toBe(DVORAK.name);
    const { input, ui } = renderPicker();
    await type(input, "DVORAK");

    await testing.waitFor(() =>
      expect(optionLabels(ui)).toEqual([expect.stringContaining(DVORAK.name)]),
    );
  });

  test("finds a member by email when the name does not match", async () => {
    expect(HORAK.name.toLowerCase()).not.toContain("th@");
    const { input, ui } = renderPicker();
    await type(input, "th@");

    await testing.waitFor(() =>
      expect(optionLabels(ui)).toEqual([expect.stringContaining(HORAK.name)]),
    );
  });

  test("a search that matches nobody shows the empty state", async () => {
    const { input, ui } = renderPicker();
    await type(input, "arbitration");

    await testing.waitFor(() =>
      expect(ui.getByText(messages.common.noResults)).toBeDefined(),
    );
    expect(optionLabels(ui)).toEqual([]);
  });

  test("lists members by name with their avatar and email", async () => {
    const { input, ui } = renderPicker();
    await press(input, "ArrowDown");

    // Each row reads avatar initials, then the name, then the email.
    await testing.waitFor(() =>
      expect(optionLabels(ui)).toEqual([
        `ED${DVORAK.name}${DVORAK.email}`,
        `PN${NOVAKOVA.name}${NOVAKOVA.email}`,
        `TH${HORAK.name}${HORAK.email}`,
      ]),
    );
  });
});

describe("member combobox choice", () => {
  test("Enter chooses the highlighted member and Enter again submits", async () => {
    const { changes, input, submits, ui } = renderPicker();
    await type(input, "dvo");
    await testing.waitFor(() => expect(optionLabels(ui)).toHaveLength(1));
    await press(input, "ArrowDown");
    await press(input, "Enter");

    await testing.waitFor(() => expect(changes).toEqual([DVORAK.userId]));
    expect(submits()).toBe(0);
    await testing.waitFor(() => expect(input.value).toBe(DVORAK.name));

    await press(input, "Enter");
    expect(submits()).toBe(1);
    expect(changes).toEqual([DVORAK.userId]);
  });

  test("Enter submits nothing before a member is chosen", async () => {
    const { input, submits } = renderPicker();
    await testing.act(async () => {
      input.focus();
    });
    await press(input, "Enter");
    expect(submits()).toBe(0);
  });

  test("people who cannot be chosen are listed, disabled, with the reason", async () => {
    const reason = messages.workspaces.members.alreadyOnMatter;
    const { changes, input, ui } = renderPicker({
      unavailable: { userIds: new Set([HORAK.userId]), reason },
    });
    await type(input, "horak");

    const option = await testing.waitFor(() => {
      const found = ui.getAllByRole("option");
      expect(found).toHaveLength(1);
      return found.at(0) ?? panic("No option");
    });
    expect(option.textContent).toContain(HORAK.name);
    expect(option.textContent).toContain(reason);
    expect(option.getAttribute("aria-disabled")).toBe("true");

    await testing.act(async () => {
      testing.fireEvent.click(option);
    });
    await press(input, "ArrowDown");
    await press(input, "Enter");
    expect(changes).toEqual([]);
  });

  test("emptying the input to search again keeps the chosen member", async () => {
    const { changes, input } = renderPicker({ initial: DVORAK.userId });
    expect(input.value).toBe(DVORAK.name);
    await type(input, "");

    expect(changes).toEqual([]);
  });

  test("the nobody row chooses nobody", async () => {
    const noneLabel = messages.common.unassigned;
    const { changes, input, ui } = renderPicker({
      choice: { type: MEMBER_CHOICE.memberOrNone, noneLabel },
      initial: DVORAK.userId,
    });
    await type(input, "unass");
    const option = await testing.waitFor(() => {
      const found = ui.getAllByRole("option");
      expect(found.map((item) => item.textContent)).toEqual([noneLabel]);
      return found.at(0) ?? panic("No option");
    });
    await testing.act(async () => {
      testing.fireEvent.click(option);
    });

    await testing.waitFor(() => expect(changes).toEqual([null]));
  });

  test("settles within a few commits after mounting and after a keystroke", async () => {
    let commits = 0;
    const { input } = renderPicker({
      onCommit: () => {
        commits += 1;
        if (commits > SETTLE_COMMITS) {
          panic(`MemberCombobox did not settle: ${commits} commits`);
        }
      },
    });
    await testing.act(async () => {});
    expect(commits).toBeLessThanOrEqual(SETTLE_COMMITS);

    commits = 0;
    await type(input, "a");
    expect(commits).toBeGreaterThan(0);
    expect(commits).toBeLessThanOrEqual(SETTLE_COMMITS);
  });
});
