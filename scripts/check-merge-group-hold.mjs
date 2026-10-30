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
  const entries = parseMergeGroupEntries({ group, added, fail });
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
    checkMergeGroupHold({
      eventName: process.env["GITHUB_EVENT_NAME"],
      group,
      repository: process.env["GITHUB_REPOSITORY"],
      readApi: (endpoint) =>
        JSON.parse(
          execFileSync("bash", ["scripts/gh-retry.sh", "api", endpoint], {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "pipe"],
          }),
        ),
    });
  } catch (error) {
    const failure =
      error instanceof MergeGroupHoldError
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
