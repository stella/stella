// The merge queue squashes each entry onto its predecessor. Membership comes
// from the immutable group commits, never from the last PR named by the ref.
/**
 * @param {{ group: unknown, added: unknown, fail: (code: string) => never }} options
 */
export const parseMergeGroupEntries = ({ group, added, fail }) => {
  const MAX_GROUP_ENTRIES = 100;
  /** @param {unknown} value @returns {value is Record<string, unknown>} */
  const record = (value) =>
    typeof value === "object" && value !== null && !Array.isArray(value);
  /** @param {unknown} value @returns {value is unknown[]} */
  const array = (value) => Array.isArray(value);
  /** @param {unknown} value @returns {value is number} */
  const positiveInteger = (value) =>
    typeof value === "number" && Number.isSafeInteger(value) && value > 0;
  /** @param {unknown} value @returns {value is string} */
  const validSha = (value) =>
    typeof value === "string" && /^[0-9a-f]{40}$/u.test(value);
  if (
    !record(group) ||
    !validSha(group["base_sha"]) ||
    !validSha(group["head_sha"]) ||
    !record(added) ||
    !array(added["commits"]) ||
    !positiveInteger(added["total_commits"]) ||
    added["total_commits"] > MAX_GROUP_ENTRIES ||
    added["commits"].length !== added["total_commits"]
  )
    return fail("CLA_UNEXPECTED_GROUP_COMMIT");
  const entries = [];
  let base = group["base_sha"];
  for (const commit of added["commits"]) {
    const parents = record(commit) ? commit["parents"] : undefined;
    const parent = array(parents) ? parents.at(0) : undefined;
    const data = record(commit) ? commit["commit"] : undefined;
    if (
      !record(commit) ||
      !validSha(commit["sha"]) ||
      !array(parents) ||
      parents.length !== 1 ||
      !record(parent) ||
      parent["sha"] !== base ||
      !record(data) ||
      typeof data["message"] !== "string"
    )
      return fail("CLA_UNEXPECTED_GROUP_COMMIT");
    const number = Number(
      data["message"]
        .split("\n", 1)
        .join("")
        .trimEnd()
        .match(/\(#([1-9][0-9]*)\)$/u)?.[1],
    );
    if (!positiveInteger(number)) fail("CLA_UNEXPECTED_GROUP_COMMIT");
    entries.push({
      number,
      baseCommit: { oid: base },
      headCommit: { oid: commit["sha"] },
    });
    base = commit["sha"];
  }
  if (base !== group["head_sha"]) fail("CLA_UNEXPECTED_GROUP_COMMIT");
  if (new Set(entries.map(({ number }) => number)).size !== entries.length)
    fail("CLA_AMBIGUOUS_GROUP_CHAIN");
  return entries;
};
