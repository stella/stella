import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, describe, expect, test } from "bun:test";

import { unregisterDomEnvironment } from "@stll/property-testing/dom-environment";

import type { ProviderCredentialDraft } from "@/components/ai-config-role-models.logic";
import messages from "@/i18n/langs/en.json";

GlobalRegistrator.register({
  url: "http://localhost:3000/admin",
});
const { useState } = await import("react");
const { act, cleanup, fireEvent, render, screen, waitFor } =
  await import("@testing-library/react");
const { IntlProvider } = await import("use-intl");
const { createProviderCredentialDraft } =
  await import("@/components/ai-config-role-models.logic");
const { FormattingProvider } = await import("@/i18n/formatting-context");
const { AIProviderRows } = await import("./ai-provider-rows");
const labels = messages.organization.aiConfig;
const VALID_KEY = `sk-or-v1-${"a".repeat(32)}1234`;
const MASKED_KEY = "sk-or-v1****1234";
afterEach(cleanup);
afterAll(async () => {
  cleanup();
  await act(async () => await Promise.resolve());
  await unregisterDomEnvironment();
});

type MountOptions = {
  initial?: ProviderCredentialDraft[];
  disabled?: boolean;
  setupErrorCode?: string;
  keyNeed?: Parameters<typeof AIProviderRows>[0]["keyNeed"];
  roleSelections?: Parameters<typeof AIProviderRows>[0]["roleSelections"];
};
const mount = ({
  initial = [createProviderCredentialDraft("openrouter")],
  disabled = false,
  setupErrorCode,
  keyNeed = "unknown",
  roleSelections = null,
}: MountOptions = {}) => {
  const changes: ProviderCredentialDraft[][] = [];
  const removed: ProviderCredentialDraft[] = [];
  const Harness = () => {
    const [providers, setProviders] = useState(initial);
    return (
      <AIProviderRows
        providers={providers}
        storedProviders={initial}
        disabled={disabled}
        keyNeed={keyNeed}
        roleSelections={roleSelections}
        setupErrorCode={setupErrorCode}
        onChange={(next) => {
          changes.push(next);
          setProviders(next);
        }}
        onRemove={(draft) => {
          removed.push(draft);
          setProviders((current) =>
            current.filter(
              (candidate) => candidate.provider !== draft.provider,
            ),
          );
        }}
      />
    );
  };
  const view = render(
    <IntlProvider locale="en" messages={messages} timeZone="UTC">
      <FormattingProvider locale="en" timeZone="UTC">
        <Harness />
      </FormattingProvider>
    </IntlProvider>,
  );
  return { changes, removed, view };
};
const enterKey = (value = VALID_KEY) =>
  fireEvent.change(screen.getByLabelText(labels.apiKey), { target: { value } });
describe("BYOK provider rows", () => {
  test("editing stages the supplied key without a row Save action", () => {
    const { changes } = mount();
    enterKey();
    expect(changes.at(-1)?.at(0)?.apiKey).toBe(VALID_KEY);
    expect(screen.getByLabelText(labels.apiKey)).toHaveProperty(
      "value",
      VALID_KEY,
    );
    expect(
      screen.queryByRole("button", { name: messages.common.save }),
    ).toBeNull();
    expect(screen.getByText(messages.common.unsavedChanges)).toBeDefined();
    fireEvent.keyDown(screen.getByLabelText(labels.apiKey), {
      key: "Enter",
      code: "Enter",
    });
    expect(changes).toHaveLength(1);
    expect(screen.queryByRole("status")).toBeNull();
  });
  test("unusual key format remains advisory while staging the key", () => {
    const { changes } = mount();
    enterKey("invalid-key");
    expect(screen.getByRole("note").textContent).toContain(
      "Save to check it with the provider",
    );
    expect(changes.at(-1)?.at(0)?.apiKey).toBe("invalid-key");
  });
  test("adding a provider emits a draft change", () => {
    const { changes } = mount();
    fireEvent.click(screen.getByRole("button", { name: labels.addProvider }));
    expect(changes.at(-1)).toHaveLength(2);
    expect(changes.at(-1)?.at(0)?.provider).toBe("openrouter");
    expect(screen.getAllByLabelText(labels.apiKey)).toHaveLength(2);
  });
  test("removing an unsaved provider stages removal immediately", () => {
    const { removed } = mount();
    fireEvent.click(
      screen.getByRole("button", { name: labels.removeProvider }),
    );
    expect(removed.at(0)?.provider).toBe("openrouter");
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });
  test("pending persistence disables draft controls", () => {
    const { changes, removed } = mount({ disabled: true });
    expect(screen.getByLabelText(labels.apiKey)).toHaveProperty(
      "disabled",
      true,
    );
    expect(
      screen.getByRole("button", { name: labels.addProvider }),
    ).toHaveProperty("disabled", true);
    const remove = screen.getByRole("button", { name: labels.removeProvider });
    expect(remove.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(remove);
    fireEvent.keyDown(remove, { key: "Enter", code: "Enter" });
    fireEvent.keyDown(remove, { key: " ", code: "Space" });
    expect(changes).toEqual([]);
    expect(removed).toEqual([]);
  });
  test("Replace reopens a saved row with an empty concealed input", () => {
    const { changes } = mount({
      initial: [
        {
          ...createProviderCredentialDraft("openrouter"),
          apiKeyMasked: MASKED_KEY,
          replacingKey: false,
        },
      ],
    });
    fireEvent.click(screen.getByRole("button", { name: labels.replaceKey }));
    const input = screen.getByLabelText(labels.apiKey);
    expect(input).toHaveProperty("value", "");
    expect(input).toHaveProperty("type", "password");
    expect(changes.at(-1)?.at(0)?.replacingKey).toBe(true);
    expect(
      screen.queryByRole("button", { name: messages.common.save }),
    ).toBeNull();
  });
  test("Remove stages removal after confirmation", async () => {
    const { removed } = mount({
      initial: [
        {
          ...createProviderCredentialDraft("openrouter"),
          apiKeyMasked: MASKED_KEY,
          replacingKey: false,
        },
      ],
    });
    fireEvent.click(
      screen.getByRole("button", { name: labels.removeProvider }),
    );
    expect(removed).toEqual([]);
    expect(await screen.findByRole("alertdialog")).toBeDefined();
    fireEvent.click(
      screen.getByRole("button", { name: messages.common.confirm }),
    );
    await waitFor(() =>
      expect(screen.queryByText(MASKED_KEY) === null).toBe(true),
    );
    expect(removed.at(0)?.provider).toBe("openrouter");
    expect(removed).toHaveLength(1);
  });
  test("typing reports unsaved changes and clearing removes that status", () => {
    mount();
    expect(screen.queryByText(messages.common.unsavedChanges)).toBeNull();
    enterKey();
    expect(screen.getByText(messages.common.unsavedChanges)).toBeDefined();
    enterKey("");
    expect(screen.queryByText(messages.common.unsavedChanges)).toBeNull();
  });
  test("a saved workspace ID can be edited while keeping the stored key", () => {
    const { changes } = mount({
      initial: [
        {
          ...createProviderCredentialDraft("anthropic"),
          apiKeyMasked: "sk-ant-usr-****1234",
          anthropicWorkspaceId: "wrkspc_old",
          replacingKey: false,
        },
      ],
    });
    fireEvent.click(screen.getByRole("button", { name: labels.replaceKey }));
    fireEvent.change(screen.getByLabelText(labels.anthropicWorkspaceId), {
      target: { value: "wrkspc_new" },
    });
    expect(screen.getByText(messages.common.unsavedChanges)).toBeDefined();
    expect(changes.at(-1)?.at(0)?.apiKey).toBe("");
    expect(changes.at(-1)?.at(0)?.anthropicWorkspaceId).toBe("wrkspc_new");
  });
  test("canceling removal preserves the saved row", async () => {
    const { removed } = mount({
      initial: [
        {
          ...createProviderCredentialDraft("openrouter"),
          apiKeyMasked: MASKED_KEY,
          replacingKey: false,
        },
      ],
    });
    fireEvent.click(
      screen.getByRole("button", { name: labels.removeProvider }),
    );
    await screen.findByRole("alertdialog");
    fireEvent.click(
      screen.getByRole("button", { name: messages.common.cancel }),
    );
    expect(removed).toEqual([]);
    expect(screen.getByText(MASKED_KEY)).toBeDefined();
  });
  test("parent setup error exposes the Anthropic workspace recovery field", () => {
    const { changes } = mount({
      initial: [createProviderCredentialDraft("anthropic")],
      setupErrorCode: "ai_config_anthropic_workspace_required",
    });
    fireEvent.change(screen.getByLabelText(labels.anthropicWorkspaceId), {
      target: { value: "wrkspc_fixture" },
    });
    expect(changes.at(-1)?.at(0)?.anthropicWorkspaceId).toBe("wrkspc_fixture");
  });
  test("user-scoped Anthropic keys expose the workspace field", () => {
    mount({ initial: [createProviderCredentialDraft("anthropic")] });
    expect(screen.queryByLabelText(labels.anthropicWorkspaceId)).toBeNull();
    enterKey("sk-ant-usr-recordedfixture1234567890");
    expect(screen.getByLabelText(labels.anthropicWorkspaceId)).toBeDefined();
  });
  test("an organization without keys shows no blank row, only how AI runs without one", () => {
    mount({ initial: [], keyNeed: "builtIn" });
    expect(screen.queryByLabelText(labels.apiKey)).toBeNull();
    expect(screen.queryByLabelText(labels.provider)).toBeNull();
    expect(screen.getByText(labels.noProviders)).toBeDefined();
    expect(screen.getByText(labels.keyNeed.builtIn)).toBeDefined();
    expect(screen.queryByText(labels.providersDescription)).toBeNull();
  });
  test("an organization that needs a key says so", () => {
    mount({ initial: [], keyNeed: "keyRequired" });
    expect(screen.getByText(labels.keyNeed.keyRequired)).toBeDefined();
  });
  test("the generic line stays while the need is unknown", () => {
    mount({ initial: [] });
    expect(screen.getByText(labels.providersDescription)).toBeDefined();
  });
  test("each saved key names the modes it serves", () => {
    const saved = (provider: "openrouter" | "anthropic") => ({
      ...createProviderCredentialDraft(provider),
      apiKeyMasked: MASKED_KEY,
      replacingKey: false,
    });
    mount({
      initial: [saved("openrouter"), saved("anthropic")],
      keyNeed: "ownKeys",
      roleSelections: {
        chat: { provider: "openrouter", modelId: "chat-model" },
        fast: null,
        reasoning: null,
        pdf: { provider: "openrouter", modelId: "pdf-model" },
        browse: null,
      },
    });
    expect(screen.getByText(labels.keyNeed.ownKeys)).toBeDefined();
    expect(
      screen.getByText(
        labels.providerModes.replace("{modes}", () =>
          new Intl.ListFormat("en").format([
            labels.roles.chat,
            labels.roles.pdf,
          ]),
        ),
      ),
    ).toBeDefined();
    expect(screen.getByText(labels.providerModesNone)).toBeDefined();
  });
  test("a row being edited does not claim modes", () => {
    mount({
      roleSelections: {
        chat: { provider: "openrouter", modelId: "chat-model" },
        fast: null,
        reasoning: null,
        pdf: null,
        browse: null,
      },
    });
    expect(screen.queryByText(/Used for/u)).toBeNull();
  });
});
