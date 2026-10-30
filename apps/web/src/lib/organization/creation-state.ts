import type { QueryClient } from "@tanstack/react-query";
import { panic } from "better-result";
import { createStore } from "zustand/vanilla";

import {
  API_VALIDATION_ERROR_CODE,
  IDEMPOTENCY_IN_PROGRESS_CODE,
} from "@stll/api-contract";
import { ownEntry } from "@stll/api-contract/own-key";

import type { TranslationKey } from "@/i18n/types";
import { APIError } from "@/lib/errors/api";
import type { SafeId } from "@/lib/safe-id";

const REFUSAL_MESSAGES = {
  account_access_unavailable: "organization.creationNotAllowed",
  rate_limited: "organization.creationRateLimited",
  [API_VALIDATION_ERROR_CODE]: "organization.creationInvalidName",
  organization_slug_conflict: "organization.creationSlugConflict",
} as const satisfies Record<string, TranslationKey>;

type CreationFailure =
  { type: "refused"; message: TranslationKey } | { type: "unknown" };

const classifyCreationFailure = (error: unknown): CreationFailure => {
  // Only a parsed server envelope can establish a definite refusal. A pending
  // receipt still has an unknown outcome, despite its HTTP conflict status.
  if (
    !APIError.is(error) ||
    error.transportKind !== undefined ||
    error.status < 400 ||
    error.status >= 500 ||
    error.code === undefined ||
    error.code === IDEMPOTENCY_IN_PROGRESS_CODE
  ) {
    return { type: "unknown" };
  }
  const mappedMessage = ownEntry(REFUSAL_MESSAGES, error.code);
  if (mappedMessage !== undefined) {
    return { type: "refused", message: mappedMessage };
  }
  if (error.status === 429) {
    return { type: "refused", message: "organization.creationRateLimited" };
  }
  if (error.status === 401 || error.status === 403) {
    return { type: "refused", message: "organization.creationNotAllowed" };
  }
  return { type: "refused", message: "organization.creationRefused" };
};

type CreationIntent = { name: string; idempotencyKey: string };
type CreatedOrganization = {
  organizationId: string;
  name: string;
  slug: string;
};

type OrganizationCreationState =
  | { status: "draft"; name: string }
  | { status: "refused"; name: string; message: TranslationKey }
  | { status: "creating"; intent: CreationIntent }
  | { status: "retry"; intent: CreationIntent }
  | { status: "confirm_restart"; intent: CreationIntent }
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
      const current = state.getState();
      if (current.status === "draft" || current.status === "refused") {
        state.setState({ status: "draft", name }, true);
      }
    },
    begin: (createKey: () => string) => {
      const current = state.getState();
      switch (current.status) {
        case "draft":
        case "refused": {
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
        case "confirm_restart":
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
    failed: (intent: CreationIntent, error: unknown) => {
      const current = state.getState();
      if (current.status !== "creating" || current.intent !== intent) {
        panic("Organization creation failed without its pending intent");
      }
      const failure = classifyCreationFailure(error);
      switch (failure.type) {
        case "refused":
          state.setState(
            { status: "refused", name: intent.name, message: failure.message },
            true,
          );
          return;
        case "unknown":
          state.setState({ status: "retry", intent }, true);
          return;
        default:
          failure satisfies never;
          return panic("Unhandled organization creation failure");
      }
    },
    requestRestart: () => {
      const current = state.getState();
      if (current.status !== "retry") {
        return panic("Only an uncertain creation can be discarded");
      }
      state.setState(
        { status: "confirm_restart", intent: current.intent },
        true,
      );
    },
    cancelRestart: () => {
      const current = state.getState();
      if (current.status !== "confirm_restart") {
        return panic("No organization restart confirmation is pending");
      }
      state.setState({ status: "retry", intent: current.intent }, true);
    },
    confirmRestart: () => {
      const current = state.getState();
      if (current.status !== "confirm_restart") {
        return panic("Discarding an uncertain creation requires confirmation");
      }
      state.setState({ status: "draft", name: current.intent.name }, true);
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
        case "refused":
        case "creating":
        case "retry":
        case "confirm_restart":
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
        message: null,
        editable: true,
        organization: null,
        canRestart: false,
      };
    case "refused":
      return {
        name: state.name,
        pending: false,
        message: state.message,
        editable: true,
        organization: null,
        canRestart: false,
      };
    case "creating":
      return {
        name: state.intent.name,
        pending: true,
        message: null,
        editable: false,
        organization: null,
        canRestart: false,
      };
    case "retry":
    case "confirm_restart":
      return {
        name: state.intent.name,
        pending: false,
        message: "organization.creationOutcomeUnknown",
        editable: false,
        organization: null,
        canRestart: true,
      } as const;
    case "created":
    case "switching":
    case "switch_error":
      return {
        name: state.organization.name,
        pending: state.status === "switching",
        message: state.status === "switch_error" ? "errors.actionFailed" : null,
        editable: false,
        organization: state.organization,
        canRestart: false,
      } as const;
    default:
      state satisfies never;
      return panic("Unhandled organization creation view");
  }
};
