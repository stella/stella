// Passive regression fixture for require-eden-error-check.

import { api } from "@/lib/api";
import {
  toAPIError,
  unwrapEden as unwrapResponse,
} from "@/lib/errors/api";

declare const consume: (value: unknown) => void;
declare const condition: boolean;

// oxlint-disable-next-line require-eden-error-check/require-eden-error-check -- fixture: then does not inspect Eden's error channel
api.tasks.get().then(consume);
// oxlint-disable-next-line require-eden-error-check/require-eden-error-check -- fixture: catch is not Eden's HTTP error channel
api.tasks.get().catch(consume);

export const discardedAwait = async () => {
  // oxlint-disable-next-line require-eden-error-check/require-eden-error-check -- fixture: bare await discards data and error
  await api.tasks.get();
};

// oxlint-disable-next-line require-eden-error-check/require-eden-error-check -- fixture: bare promise discard cannot inspect error
api.tasks.get();
// oxlint-disable-next-line require-eden-error-check/require-eden-error-check -- fixture: void discard cannot inspect error
void api.tasks.get();

export const inspectedLater = async () => {
  const response = await api.tasks.get();
  return response.error;
};

// MUST flag: simply binding the response does not inspect its error channel.
export const uncheckedAtScopeCompletion = async () => {
  // oxlint-disable-next-line require-eden-error-check/require-eden-error-check -- fixture: an assigned response cannot silently leave scope
  const response = await api.tasks.get();
  consume(typeof response);
};

// MUST flag: a later error read cannot repair earlier data consumption.
export const dataBeforeError = async () => {
  // oxlint-disable-next-line require-eden-error-check/require-eden-error-check -- fixture: data is consumed before the error channel
  const response = await api.tasks.get();
  consume(response.data);
  consume(response.error);
};

// MUST flag: overwriting `.error` is not an inspection of the original
// response's error channel.
export const overwrittenErrorBeforeData = async () => {
  // oxlint-disable-next-line require-eden-error-check/require-eden-error-check -- fixture: writing the error property cannot prove the original error was read
  const response = await api.tasks.get();
  response.error = null;
  return response.data;
};

// MUST flag: returning the whole unchecked response escapes both channels.
export const returnedUncheckedResponse = async () => {
  // oxlint-disable-next-line require-eden-error-check/require-eden-error-check -- fixture: returning an unchecked response is an escape
  const response = await api.tasks.get();
  return response;
};

// MUST flag: an opaque consumer cannot prove that it handles Eden errors.
export const escapedToOpaqueConsumer = async () => {
  // oxlint-disable-next-line require-eden-error-check/require-eden-error-check -- fixture: passing an unchecked response to an opaque helper is unsafe
  const response = await api.tasks.get();
  consume(response);
};

// MUST flag: reassigning the binding discards the first response. The second
// response is inspected so the fixture isolates the overwritten value.
export const reassignedBeforeInspection = async () => {
  // oxlint-disable-next-line require-eden-error-check/require-eden-error-check, eslint/no-useless-assignment -- fixture: reassignment discards the first error channel
  let response = await api.tasks.get();
  response = await api.tasks.get();
  consume(response.error);
};

// MUST flag: assignment into an outer binding is followed beyond the try
// block to the binding's actual scope completion.
export const assignedInsideTryWithoutCheck = async () => {
  let response: Awaited<ReturnType<typeof api.tasks.get>>;
  try {
    // oxlint-disable-next-line require-eden-error-check/require-eden-error-check -- fixture: a nested assignment cannot hide an unchecked outer binding
    response = await api.tasks.get();
  } catch {
    return null;
  }
  consume(typeof response);
  return undefined;
};

// MUST flag: inspection in one conditional branch does not dominate the
// later data read on the other branch.
export const inspectedOnOnlyOneBranch = async () => {
  // oxlint-disable-next-line require-eden-error-check/require-eden-error-check -- fixture: one branch leaves the error channel unchecked
  const response = await api.tasks.get();
  if (condition) {
    consume(response.error);
  }
  return response.data;
};

// MUST flag: short-circuiting can skip the only error read, so it cannot
// establish a post-expression guarantee.
export const inspectedOnOnlyOneLogicalBranch = async () => {
  // oxlint-disable-next-line require-eden-error-check/require-eden-error-check -- fixture: a short-circuited error read is not guaranteed
  const response = await api.tasks.get();
  if (condition) {
    consume(response.error);
  }
  return response.data;
};

// MUST flag: stable endpoint aliases retain Eden import provenance.
const taskEndpoint = api.tasks;
export const uncheckedEndpointAlias = async () => {
  // oxlint-disable-next-line require-eden-error-check/require-eden-error-check -- fixture: endpoint aliases cannot bypass assigned-result analysis
  const response = await taskEndpoint.get();
  return response.data;
};

// MUST flag: data-only destructuring drops the sibling error channel.
export const dataOnlyDestructure = async () => {
  // oxlint-disable-next-line require-eden-error-check/require-eden-error-check -- fixture: destructuring data alone ignores Eden errors
  const { data } = await api.tasks.get();
  return data;
};

// Allowed: checking `.error` in the condition dominates the later data read.
export const checkedBeforeData = async () => {
  const response = await api.tasks.get();
  if (response.error) {
    throw toAPIError(response.error);
  }
  return response.data;
};

// Allowed: both paths inspect the error channel before they merge.
export const checkedOnBothBranches = async () => {
  const response = await api.tasks.get();
  if (condition) {
    consume(response.error);
  } else {
    consume(response.error);
  }
  return response.data;
};

// Allowed: the only deliberate throw happens after `.error` is read, and
// both the success return and catch return exit with a handled response.
export const checkedBeforeCaughtThrow = async () => {
  const response = await api.tasks.get();
  try {
    if (response.error) {
      throw toAPIError(response.error);
    }
    return response.data;
  } catch {
    return null;
  }
};

// Allowed: an acquisition assigned inside try is checked in the outer
// binding's continuation after the transport-error catch exits.
export const assignedInsideTryCheckedAfter = async () => {
  let response: Awaited<ReturnType<typeof api.tasks.get>>;
  try {
    response = await api.tasks.get();
  } catch {
    return null;
  }
  consume(response.error);
  return response.data;
};

// Allowed: direct and later destructuring explicitly retain both channels.
export const directlyDestructured = async () => {
  const { data, error } = await api.tasks.get();
  consume(error);
  return data;
};

export const destructuredAfterAssignment = async () => {
  const response = await api.tasks.get();
  const { data, error } = response;
  consume(error);
  return data;
};

export const destructuredByAssignment = async () => {
  const response = await api.tasks.get();
  // oxlint-disable-next-line eslint/prefer-const -- fixture: assignment destructuring requires a mutable target
  let data: unknown;
  // oxlint-disable-next-line eslint/prefer-const -- fixture: assignment destructuring requires a mutable target
  let error: unknown;
  ({ data, error } = response);
  consume(error);
  return data;
};

// Allowed: the canonical imported adapter checks and unwraps the whole
// response. Its local import alias retains adapter provenance.
export const passedToApprovedAdapter = async () => {
  const response = await api.tasks.get();
  return unwrapResponse(response);
};

// MUST flag: a same-shaped local helper is not the canonical imported
// response adapter and cannot establish that the error channel was handled.
export const passedToLocalAdapter = async () => {
  // oxlint-disable-next-line require-eden-error-check/require-eden-error-check -- fixture: only the proven imported adapter may consume the whole response
  const response = await api.tasks.get();
  const unwrapLocally = (value: unknown) => value;
  return unwrapLocally(response);
};

// Allowed: endpoint aliases remain supported when the assigned response is
// checked normally.
export const checkedEndpointAlias = async () => {
  const response = await taskEndpoint.get();
  consume(response.error);
  return response.data;
};

export const unrelatedApi = async (
  // oxlint-disable-next-line eslint/no-shadow -- fixture: proves Eden import matching is binding-aware
  api: {
    tasks: { get: () => Promise<void> };
  },
) => api.tasks.get();

// Allowed: an assigned response from a locally shadowed API-shaped object is
// unrelated to the imported Eden client.
export const assignedLocalApi = async (
  // oxlint-disable-next-line eslint/no-shadow -- fixture: local API provenance must remain distinct
  api: {
    tasks: {
      get: () => Promise<{ data: string; error: null }>;
    };
  },
) => {
  const response = await api.tasks.get();
  return response.data;
};
