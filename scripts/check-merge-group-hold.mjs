import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { parseMergeGroupEntries } from "./merge-group-entries.mjs";

export const HOLD_LABEL = "hold";

/** @param {unknown} value @returns {value is Record<string, unknown>} */
const record = (value) =>
  typeof value === "object" && value !== null && !Array.isArray(value);
/** @param {unknown} value @returns {value is unknown[]} */
const array = (value) => Array.isArray(value);
/** @param {unknown} value @returns {value is { name: string }} */
const label = (value) => record(value) && typeof value["name"] === "string";

export class MergeGroupHoldError extends Error {
  /** @param {{ code: string, group: unknown, detail: string }} options */
  constructor({ code, group, detail }) {
    const ref = record(group) ? group["head_ref"] : undefined;
    const sha = record(group) ? group["head_sha"] : undefined;
    super(
      `${code}: group ${ref ?? "unknown"} (${sha ?? "unknown"}): ${detail}`,
    );
    this.name = "MergeGroupHoldError";
  }
}

/**
 * @param {{ eventName: string | undefined, group: unknown,
 * repository: string | undefined, readApi: (endpoint: string) => unknown }} options
 */
export const checkMergeGroupHold = ({
  eventName,
  group,
  repository,
  readApi,
}) => {
  if (eventName === "pull_request") return;
  /** @param {string} code @returns {never} */
  const fail = (code) => {
    throw new MergeGroupHoldError({
      code,
      group,
      detail: "cannot resolve every group member",
    });
  };
  if (
    eventName !== "merge_group" ||
    !record(group) ||
    typeof group["base_sha"] !== "string" ||
    !/^[a-f0-9]{40}$/u.test(group["base_sha"]) ||
    typeof group["head_sha"] !== "string" ||
    !/^[a-f0-9]{40}$/u.test(group["head_sha"]) ||
    typeof group["head_ref"] !== "string"
  ) {
    fail("HOLD_INVALID_GROUP");
  }
  /** @param {string} endpoint @returns {unknown} */
  const read = (endpoint) => {
    try {
      return readApi(endpoint);
    } catch {
      throw new MergeGroupHoldError({
        code: "HOLD_API_ERROR",
        group,
        detail: `cannot read ${endpoint}`,
      });
    }
  };
  const added = read(
    `repos/${repository}/compare/${group["base_sha"]}...${group["head_sha"]}`,
  );
  const entries = parseMergeGroupEntries({
    group,
    added,
    fail: () => fail("HOLD_UNMAPPABLE_GROUP"),
  });
  const held = [];
  for (const { number } of entries) {
    // Read labels at verification time; enqueue payloads are not authoritative.
    const pull = read(`repos/${repository}/pulls/${number}`);
    const labels = record(pull) ? pull["labels"] : undefined;
    if (
      !record(pull) ||
      pull["number"] !== number ||
      !array(labels) ||
      !labels.every(label)
    )
      fail("HOLD_INVALID_PULL");
    if (labels.some(({ name }) => name.toLowerCase() === HOLD_LABEL))
      held.push(number);
  }
  if (held.length)
    throw new MergeGroupHoldError({
      code: "HOLD_LABEL_PRESENT",
      group,
      detail: `pull requests ${held.map((number) => `#${number}`).join(", ")} carry ${HOLD_LABEL}`,
    });
};

export class HeldPullRequestError extends Error {
  /** @param {{ code: string, number: unknown, detail: string }} options */
  constructor({ code, number, detail }) {
    super(`${code}: PR #${number}: ${detail}`);
    this.name = "HeldPullRequestError";
  }
}

/**
 * @param {{ event: unknown, repository: string | undefined,
 * holdValue: string | undefined,
 * addLabel: (endpoint: string) => unknown,
 * readApi: (endpoint: string) => unknown,
 * graphql: (options: { query: string, id: string }) => unknown }} options
 */
export const dequeueHeldPullRequest = ({
  event,
  repository,
  holdValue,
  addLabel,
  readApi,
  graphql,
}) => {
  const number =
    record(event) && record(event["pull_request"])
      ? event["pull_request"]["number"]
      : undefined;
  /** @type {(code: string) => never} */
  const fail = (code) => {
    throw new HeldPullRequestError({
      code,
      number,
      detail: "cannot verify removal from the merge queue",
    });
  };
  if (
    !record(event) ||
    typeof number !== "number" ||
    !Number.isSafeInteger(number) ||
    number < 1
  ) {
    return fail("HOLD_INVALID_PULL_EVENT");
  }
  switch (event["action"]) {
    case "unlabeled":
    case "labeled": {
      const applied = event["label"];
      if (!label(applied)) return fail("HOLD_INVALID_LABEL_EVENT");
      if (applied.name.toLowerCase() !== HOLD_LABEL) return;
      if (event["action"] === "unlabeled") {
        if (typeof holdValue !== "string")
          return fail("HOLD_MISSING_VARIABLE_CONTEXT");
        if (holdValue === "") return;
      }
      break;
    }
    case "reopened":
      break;
    default:
      return;
  }
  // This is an API boundary: every transport or response failure names the PR.
  try {
    const pull = readApi(`repos/${repository}/pulls/${number}`);
    const labels = record(pull) ? pull["labels"] : undefined;
    if (
      !record(pull) ||
      pull["number"] !== number ||
      typeof pull["node_id"] !== "string" ||
      !array(labels) ||
      !labels.every(label)
    )
      return fail("HOLD_INVALID_PULL");
    if (event["action"] === "unlabeled") {
      const head = pull["head"];
      if (
        !record(head) ||
        typeof head["sha"] !== "string" ||
        !/^[a-f0-9]{40}$/u.test(head["sha"])
      )
        return fail("HOLD_INVALID_PULL_HEAD");
      // Match the clearance grammar: an exact head, then optional whitespace/status.
      const clearance =
        /^cleared @([a-fA-F0-9]{40})(?:\p{White_Space}|$)/u.exec(
          holdValue ?? "",
        );
      if (clearance?.[1] === head["sha"]) return;
      const restored = addLabel(`repos/${repository}/issues/${number}/labels`);
      if (
        !array(restored) ||
        !restored.every(label) ||
        !restored.some(({ name }) => name.toLowerCase() === HOLD_LABEL)
      )
        return fail("HOLD_LABEL_RESTORE_FAILED");
    } else if (!labels.some(({ name }) => name.toLowerCase() === HOLD_LABEL))
      return;
    const id = pull["node_id"];
    const response = graphql({
      query:
        "query($id: ID!) { node(id: $id) { ... on PullRequest { id mergeQueueEntry { id } } } }",
      id,
    });
    const data =
      record(response) && response["errors"] === undefined
        ? response["data"]
        : undefined;
    const node = record(data) ? data["node"] : undefined;
    if (!record(node) || node["id"] !== id)
      return fail("HOLD_INVALID_QUEUE_RESPONSE");
    const entry = node["mergeQueueEntry"];
    if (entry === null) return;
    if (!record(entry) || typeof entry["id"] !== "string")
      return fail("HOLD_INVALID_QUEUE_RESPONSE");
    const removed = graphql({
      query:
        "mutation($id: ID!) { dequeuePullRequest(input: { id: $id }) { mergeQueueEntry { id } } }",
      id,
    });
    const removedData =
      record(removed) && removed["errors"] === undefined
        ? removed["data"]
        : undefined;
    const result = record(removedData)
      ? removedData["dequeuePullRequest"]
      : undefined;
    const removedEntry = record(result) ? result["mergeQueueEntry"] : undefined;
    if (!record(removedEntry) || removedEntry["id"] !== entry["id"])
      return fail("HOLD_DEQUEUE_FAILED");
  } catch (error) {
    if (error instanceof HeldPullRequestError) throw error;
    throw new HeldPullRequestError({
      code: "HOLD_DEQUEUE_API_ERROR",
      number,
      detail:
        "GitHub API rejected label restoration, queue verification or dequeue; check pull-requests: write permission",
    });
  }
};

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  /** @type {unknown} */
  let group;
  try {
    const eventPath = process.env["GITHUB_EVENT_PATH"];
    if (!eventPath) throw new TypeError("GITHUB_EVENT_PATH is required");
    /** @type {unknown} */
    const event = JSON.parse(readFileSync(eventPath, "utf8"));
    if (!record(event)) throw new TypeError("Invalid GitHub event");
    group = event["merge_group"];
    /** @param {string[]} args @returns {unknown} */
    const api = (args) =>
      JSON.parse(
        execFileSync("bash", ["scripts/gh-retry.sh", "api", ...args], {
          encoding: "utf8",
          maxBuffer: 16 * 1024 * 1024,
          stdio: ["ignore", "pipe", "pipe"],
        }),
      );
    if (process.env["GITHUB_EVENT_NAME"] === "pull_request_target") {
      dequeueHeldPullRequest({
        event,
        repository: process.env["GITHUB_REPOSITORY"],
        holdValue: process.env["PR_HOLD_VALUE"],
        addLabel: (endpoint) =>
          api([endpoint, "--method", "POST", "-f", `labels[]=${HOLD_LABEL}`]),
        readApi: (endpoint) => api([endpoint]),
        graphql: ({ query, id }) =>
          api(["graphql", "-f", `query=${query}`, "-f", `id=${id}`]),
      });
    } else {
      checkMergeGroupHold({
        eventName: process.env["GITHUB_EVENT_NAME"],
        group,
        repository: process.env["GITHUB_REPOSITORY"],
        readApi: (endpoint) => api([endpoint]),
      });
    }
  } catch (error) {
    const failure =
      error instanceof MergeGroupHoldError ||
      error instanceof HeldPullRequestError
        ? error
        : new MergeGroupHoldError({
            code: "HOLD_API_OR_EVENT_ERROR",
            group,
            detail: "verification failed closed",
          });
    console.error(`${failure.name}: ${failure.message}`);
    process.exitCode = 1;
  }
}
