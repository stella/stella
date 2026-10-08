import type { ComponentProps } from "react";

import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, describe, expect, test } from "bun:test";

import { sleep } from "@stll/concurrency/sleep";

import type { ProviderCredentialDraft } from "@/components/ai-config-role-models.logic";
import messages from "@/i18n/langs/en.json";

GlobalRegistrator.register({
  url: "http://localhost:3000/settings/organization",
});
const { useState } = await import("react");
const { act, cleanup, fireEvent, render, screen, waitFor } =
  await import("@testing-library/react");
const { IntlProvider } = await import("use-intl");
const { createProviderCredentialDraft } =
  await import("@/components/ai-config-role-models.logic");
const { APIError } = await import("@/lib/errors/api");
const { AIProviderRows } = await import("./ai-provider-rows");
const labels = messages.organization.aiConfig;
const VALID_KEY = `sk-or-v1-${"a".repeat(32)}1234`;
const MASKED_KEY = "sk-or-v1****1234";
afterEach(cleanup);
afterAll(async () => {
  cleanup();
  await act(async () => await sleep(50));
  await GlobalRegistrator.unregister();
});

type MountOptions = {
  initial?: ProviderCredentialDraft[];
  saveError?: InstanceType<typeof APIError>;
};
const mount = ({
  initial = [createProviderCredentialDraft("openrouter")],
  saveError,
}: MountOptions = {}) => {
  const saved: ProviderCredentialDraft[] = [];
  const removed: ProviderCredentialDraft[] = [];
  const Harness = () => {
    const [providers, setProviders] = useState(initial);
    const onSave: ComponentProps<typeof AIProviderRows>["onSave"] = async (
      draft,
    ) => {
      saved.push(draft);
      if (saveError) {
        throw saveError;
      }
      setProviders((current) =>
        current.map((candidate) =>
          candidate.provider === draft.provider
            ? {
                ...draft,
                apiKey: "",
                apiKeyMasked: MASKED_KEY,
                replacingKey: false,
              }
            : candidate,
        ),
      );
    };
    return (
      <AIProviderRows
        providers={providers}
        disabled={false}
        onChange={setProviders}
        onSave={onSave}
        onRemove={async (draft) => {
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
      <Harness />
    </IntlProvider>,
  );
  return { saved, removed, view };
};
const enterKey = (value = VALID_KEY) =>
  fireEvent.change(screen.getByLabelText(labels.apiKey), { target: { value } });
const saveWithButton = () =>
  fireEvent.click(screen.getByRole("button", { name: messages.common.save }));

describe("BYOK provider rows", () => {
  test("Save verifies the supplied key and collapses without retaining the key", async () => {
    const { saved, view } = mount();
    enterKey();
    saveWithButton();
    expect(await screen.findByRole("status")).toHaveProperty(
      "textContent",
      labels.savedVerified,
    );
    expect(saved).toHaveLength(1);
    expect(saved.at(0)?.apiKey).toBe(VALID_KEY);
    expect(screen.getByText(MASKED_KEY)).toBeDefined();
    expect(screen.queryByLabelText(labels.apiKey)).toBeNull();
    expect(view.container.innerHTML).not.toContain(VALID_KEY);
    expect(screen.queryByText(messages.common.unsavedChanges)).toBeNull();
  });
  test("Enter in the key input saves without clicking Save", async () => {
    const { saved } = mount();
    enterKey();
    fireEvent.keyDown(screen.getByLabelText(labels.apiKey), {
      key: "Enter",
      code: "Enter",
    });
    await screen.findByText(labels.savedVerified);
    expect(saved).toHaveLength(1);
  });
  test("unusual format is advisory and the provider still receives the key", async () => {
    const { saved } = mount();
    enterKey("invalid-key");
    expect(screen.getByRole("note").textContent).toContain(
      "Save to check it with the provider",
    );
    saveWithButton();
    await screen.findByText(labels.savedVerified);
    expect(saved.at(0)?.apiKey).toBe("invalid-key");
  });
  test("provider refusal preserves its complete reason and leaves the key editable", async () => {
    const reason = `OpenRouter: key disabled. ${"Full provider explanation. ".repeat(30)}Final recovery instruction.`;
    const { saved } = mount({
      saveError: new APIError({
        status: 401,
        message: "Localized wrapper",
        rawMessage: reason,
        code: "provider_key_disabled",
      }),
    });
    enterKey();
    saveWithButton();
    expect((await screen.findByRole("alert")).textContent).toContain(reason);
    expect(saved).toHaveLength(1);
    expect(screen.getByLabelText(labels.apiKey)).toHaveProperty(
      "value",
      VALID_KEY,
    );
    expect(screen.queryByText(MASKED_KEY)).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
  });
  test("Replace reopens a saved row with an empty concealed input", () => {
    mount({
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
    expect(
      screen.getByRole("button", { name: messages.common.save }),
    ).toBeDefined();
  });
  test("Remove deletes the saved provider row", async () => {
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
    await waitFor(() => expect(screen.queryByText(MASKED_KEY)).toBeNull());
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
  test("a saved workspace ID can be edited while keeping the stored key", async () => {
    const { saved } = mount({
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
    saveWithButton();
    await screen.findByText(labels.savedVerified);
    expect(saved.at(0)?.apiKey).toBe("");
    expect(saved.at(0)?.anthropicWorkspaceId).toBe("wrkspc_new");
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
  test("user-scoped Anthropic key displays workspace guidance with its exact provider error", async () => {
    mount({
      initial: [createProviderCredentialDraft("anthropic")],
      saveError: new APIError({
        status: 400,
        message: "Workspace required",
        rawMessage: "Anthropic: workspace_id_required",
        code: "ai_config_anthropic_workspace_required",
      }),
    });
    enterKey("sk-ant-usr-recordedfixture1234567890");
    fireEvent.change(screen.getByLabelText(labels.anthropicWorkspaceId), {
      target: { value: "wrkspc_fixture" },
    });
    saveWithButton();
    expect((await screen.findByRole("alert")).textContent).toContain(
      labels.anthropicWorkspaceRequired,
    );
    expect(
      screen
        .getByRole("link", { name: labels.anthropicWorkspaces })
        .getAttribute("href"),
    ).toBe("https://console.anthropic.com/settings/workspaces");
  });
});
