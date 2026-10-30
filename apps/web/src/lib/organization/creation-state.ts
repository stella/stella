import type { QueryClient } from "@tanstack/react-query";
import { panic } from "better-result";
import { createStore } from "zustand/vanilla";

import type { SafeId } from "@/lib/safe-id";

type CreationIntent = { name: string; idempotencyKey: string };
type CreatedOrganization = {
  organizationId: string;
  name: string;
  slug: string;
};

type OrganizationCreationState =
  | { status: "draft"; name: string }
  | { status: "creating"; intent: CreationIntent }
  | { status: "retry"; intent: CreationIntent }
  | {
      status: "created";
      intent: CreationIntent;
      organization: CreatedOrganization;
    }
  | {
      status: "switching";
      intent: CreationIntent;
      organization: CreatedOrganization;
    }
  | {
      status: "switch_error";
      intent: CreationIntent;
      organization: CreatedOrganization;
    };

const createOrganizationCreationOwner = () => {
  const state = createStore((): OrganizationCreationState => ({
    status: "draft",
    name: "",
  }));
  return {
    state,
    setName: (name: string) => {
      if (state.getState().status === "draft") {
        state.setState({ status: "draft", name }, true);
      }
    },
    begin: (createKey: () => string) => {
      const current = state.getState();
      switch (current.status) {
        case "draft": {
          const name = current.name;
          if (name.trim().length === 0) {
            return null;
          }
          const intent = { name, idempotencyKey: createKey() };
          state.setState({ status: "creating", intent }, true);
          return intent;
        }
        case "retry":
          state.setState({ status: "creating", intent: current.intent }, true);
          return current.intent;
        case "creating":
        case "created":
        case "switching":
        case "switch_error":
          return null;
        default:
          current satisfies never;
          return panic("Unhandled organization creation state");
      }
    },
    created: (intent: CreationIntent, organization: CreatedOrganization) => {
      const current = state.getState();
      if (current.status !== "creating" || current.intent !== intent) {
        panic("Organization creation completed without its pending intent");
      }
      state.setState({ status: "created", intent, organization }, true);
    },
    refused: (intent: CreationIntent) => {
      const current = state.getState();
      if (current.status !== "creating" || current.intent !== intent) {
        panic("Organization creation failed without its pending intent");
      }
      state.setState({ status: "retry", intent }, true);
    },
    beginSwitch: () => {
      const current = state.getState();
      switch (current.status) {
        case "created":
        case "switch_error":
          state.setState(
            {
              status: "switching",
              intent: current.intent,
              organization: current.organization,
            },
            true,
          );
          return current.organization;
        case "draft":
        case "creating":
        case "retry":
        case "switching":
          return null;
        default:
          current satisfies never;
          return panic("Unhandled organization switch state");
      }
    },
    switchFailed: () => {
      const current = state.getState();
      if (current.status !== "switching") {
        return panic("Organization switch failed without a pending switch");
      }
      state.setState(
        {
          status: "switch_error",
          intent: current.intent,
          organization: current.organization,
        },
        true,
      );
    },
    switched: () => {
      if (state.getState().status !== "switching") {
        panic("Organization switch completed without a pending switch");
      }
      state.setState({ status: "draft", name: "" }, true);
    },
  };
};

type OrganizationCreationOwner = ReturnType<
  typeof createOrganizationCreationOwner
>;

// Client lifetime keeps unresolved account operations through navigation without
// sharing drafts between server requests, accounts, or browser documents.
const owners = new WeakMap<
  QueryClient,
  Map<SafeId<"user">, OrganizationCreationOwner>
>();

export const getOrganizationCreationOwner = (
  client: QueryClient,
  userId: SafeId<"user">,
) => {
  let byUser = owners.get(client);
  if (byUser === undefined) {
    byUser = new Map();
    owners.set(client, byUser);
  }
  let owner = byUser.get(userId);
  if (owner === undefined) {
    owner = createOrganizationCreationOwner();
    byUser.set(userId, owner);
  }
  return owner;
};

export const organizationCreationView = (state: OrganizationCreationState) => {
  switch (state.status) {
    case "draft":
      return {
        name: state.name,
        pending: false,
        failed: false,
        editable: true,
        organization: null,
      };
    case "creating":
      return {
        name: state.intent.name,
        pending: true,
        failed: false,
        editable: false,
        organization: null,
      };
    case "retry":
      return {
        name: state.intent.name,
        pending: false,
        failed: true,
        editable: false,
        organization: null,
      };
    case "created":
    case "switching":
    case "switch_error":
      return {
        name: state.organization.name,
        pending: state.status === "switching",
        failed: state.status === "switch_error",
        editable: false,
        organization: state.organization,
      };
    default:
      state satisfies never;
      return panic("Unhandled organization creation view");
  }
};
