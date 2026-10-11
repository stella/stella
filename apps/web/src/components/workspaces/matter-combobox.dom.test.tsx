import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, describe, expect, test } from "bun:test";

import type { WorkspaceNavigationItem } from "@/lib/memory-api";

GlobalRegistrator.register({ url: "http://localhost:3000/", width: 1280 });

const testing = await import("@testing-library/react");
const query = await import("@tanstack/react-query");
const { useState } = await import("react");
const { IntlProvider } = await import("use-intl");
const { default: messages } = await import("@/i18n/langs/en.json");
const { workspacesNavigationOptions } =
  await import("@/lib/workspaces/queries");
const { resolveMatterColor } = await import("@/lib/matter-colors");
const { MatterCombobox } = await import("./matter-combobox");

type MatterOption = Parameters<typeof MatterCombobox>[0]["value"];

const ORGANIZATION_ID = "00000000-0000-7000-8000-00000000ffff";
const USER_ID = "00000000-0000-7000-8000-00000000fffe";
const NOW = new Date("2026-10-11T12:00:00.000Z");

const matter = (
  id: string,
  name: string,
  color: string | null,
  client: string | null,
) =>
  ({
    client: client === null ? null : { displayName: client, id },
    clientId: null,
    color,
    defaultViewId: null,
    id,
    lastActivityAt: NOW,
    name,
    reference: null,
    status: "active",
  }) satisfies WorkspaceNavigationItem;

const NOVAK = matter(
  "00000000-0000-7000-8000-0000000000a1",
  "Novák v. Horák",
  "#b4442f",
  "Novák s.r.o.",
);
const LEASE = matter(
  "00000000-0000-7000-8000-0000000000b2",
  "Lease renewal Vinohrady",
  "#2f6db4",
  null,
);

const clients: InstanceType<typeof query.QueryClient>[] = [];

afterEach(() => {
  testing.cleanup();
  for (const client of clients) {
    client.clear();
  }
  clients.length = 0;
});
afterAll(async () => {
  await GlobalRegistrator.unregister();
});

const openCombobox = (initial: MatterOption = null) => {
  const client = new query.QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  clients.push(client);
  client.setQueryData(
    workspacesNavigationOptions({
      organizationId: ORGANIZATION_ID,
      userId: USER_ID,
    }).queryKey,
    { workspaces: [NOVAK, LEASE], features: { timeBilling: false } },
  );
  const Host = () => {
    const [value, setValue] = useState(initial);
    return (
      <MatterCombobox
        activeOrganizationId={ORGANIZATION_ID}
        id="matter"
        onChange={setValue}
        userId={USER_ID}
        value={value}
      />
    );
  };
  const ui = testing.render(
    <query.QueryClientProvider client={client}>
      <IntlProvider locale="en" messages={messages} timeZone="UTC">
        <Host />
      </IntlProvider>
    </query.QueryClientProvider>,
  );
  const input = ui.getByRole("combobox");
  if (!(input instanceof HTMLInputElement)) {
    throw new TypeError("Expected the matter combobox input");
  }
  return { input, ui };
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

/** The colour an element paints, as the DOM normalizes it. */
const paintedColor = (element: Element | null | undefined) =>
  element instanceof SVGElement ? element.style.color : "";

const expectedColor = (color: string) => {
  const probe = document.createElement("span");
  probe.style.color = color;
  expect(probe.style.color).not.toBe("");
  return probe.style.color;
};

const openList = async (input: HTMLInputElement) => {
  await testing.act(async () => {
    input.focus();
    testing.fireEvent.keyDown(input, { key: "ArrowDown" });
  });
};

describe("matter combobox", () => {
  test("the full list never shows the empty state", async () => {
    const { input, ui } = openCombobox();
    await openList(input);

    await testing.waitFor(() =>
      expect(ui.getAllByRole("option")).toHaveLength(2),
    );
    expect(ui.queryByText(messages.common.noResults)).toBeNull();
  });

  test("a search that matches nothing shows the empty state", async () => {
    const { input, ui } = openCombobox();
    await type(input, "arbitration");

    await testing.waitFor(() =>
      expect(ui.getByText(messages.common.noResults)).toBeDefined(),
    );
    expect(ui.queryAllByRole("option")).toHaveLength(0);
  });

  test("matches a client's name, ignoring accents and case", async () => {
    const { input, ui } = openCombobox();
    await type(input, "NOVAK S.R.O");

    await testing.waitFor(() =>
      expect(
        ui.getAllByRole("option").map((option) => option.textContent),
      ).toEqual([expect.stringContaining(NOVAK.name)]),
    );
  });

  test("every option draws its matter's coloured icon before the name", async () => {
    const { input, ui } = openCombobox();
    await openList(input);

    const options = await testing.waitFor(() => {
      const found = ui.getAllByRole("option");
      expect(found).toHaveLength(2);
      return found;
    });
    for (const [option, source] of [
      [options.at(0), NOVAK],
      [options.at(1), LEASE],
    ] as const) {
      const icon = option?.querySelector("svg.lucide-layers");
      expect(icon).toBeInstanceOf(SVGElement);
      expect(paintedColor(icon)).toBe(
        expectedColor(resolveMatterColor(source.id, source.color)),
      );
      // Document order: the icon, then the name.
      expect(
        [...(option?.querySelectorAll("svg.lucide-layers, bdi") ?? [])].map(
          (element) => element.textContent,
        ),
      ).toEqual([
        "",
        source.name,
        ...(source.client === null ? [] : [source.client.displayName]),
      ]);
    }
  });

  test("a chosen matter shows its name and icon in the field", () => {
    const { input, ui } = openCombobox({
      clientName: null,
      color: LEASE.color,
      id: LEASE.id,
      name: LEASE.name,
    });

    expect(input.value).toBe(LEASE.name);
    const addonIcon = ui.container.querySelector("svg.lucide-layers");
    expect(addonIcon).toBeInstanceOf(SVGElement);
    expect(paintedColor(addonIcon)).toBe(
      expectedColor(resolveMatterColor(LEASE.id, LEASE.color)),
    );
  });
});
