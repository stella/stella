import { describe, expect, test } from "bun:test";

import { API_VALIDATION_ERROR_CODE } from "@stll/api-contract";
import { createTestState } from "@stll/test-state";

const testState = createTestState({ file: import.meta.path, config: {} });

testState.setEnvIfAbsent("VITE_API_URL", "http://localhost:3001");

const { APIError } = await import("@/lib/errors/api");
const { resolveExactDuplicates } =
  await import("@/lib/files/exact-duplicate-queries");

type LookupRequest = { sha256Hexes: readonly string[]; entityCount: number };

/** Each file's hash is its name, so a test reads which bytes match. */
const hashByName = async (file: File): Promise<string> =>
  await Promise.resolve(file.name.split("#").at(0) ?? file.name);

const fileWithHash = (hash: string, name = hash): File =>
  new File(["bytes"], `${hash}#${name}`);

describe("resolveExactDuplicates", () => {
  test("maps every file whose hash the matter holds to that document", async () => {
    const lookups: LookupRequest[] = [];
    const contract = fileWithHash("aaa", "contract.pdf");
    const fresh = fileWithHash("bbb", "fresh.pdf");
    const contractCopy = fileWithHash("aaa", "contract copy.pdf");

    const duplicates = await resolveExactDuplicates({
      files: [contract, fresh, contractCopy],
      hashFile: hashByName,
      lookup: async (request) => {
        lookups.push(request);
        return await Promise.resolve([
          { sha256Hex: "aaa", entityName: "Contract.pdf" },
        ]);
      },
      onError: () => {
        throw new Error("no lookup failed");
      },
    });

    expect(duplicates).toEqual([
      { file: contract, entityName: "Contract.pdf" },
      { file: contractCopy, entityName: "Contract.pdf" },
    ]);
    // Each distinct hash is asked once; the capacity check still counts
    // every file the batch would create.
    expect(lookups).toEqual([{ sha256Hexes: ["aaa", "bbb"], entityCount: 3 }]);
  });

  test("a file that cannot be hashed is not a duplicate and does not stop the others", async () => {
    const unreadable = fileWithHash("unreadable");
    const contract = fileWithHash("aaa");

    const duplicates = await resolveExactDuplicates({
      files: [unreadable, contract],
      hashFile: async (file) =>
        file === unreadable
          ? await Promise.reject(new Error("NotReadableError"))
          : await hashByName(file),
      lookup: async ({ sha256Hexes }) =>
        await Promise.resolve(
          sha256Hexes.map((sha256Hex) => ({
            sha256Hex,
            entityName: "Contract.pdf",
          })),
        ),
      onError: () => {
        throw new Error("a hash failure is not reported");
      },
    });

    expect(duplicates).toEqual([
      { file: contract, entityName: "Contract.pdf" },
    ]);
  });

  test("a failed lookup reports the failure and lets every file upload", async () => {
    const reported: Error[] = [];

    const duplicates = await resolveExactDuplicates({
      files: [fileWithHash("aaa")],
      hashFile: hashByName,
      lookup: async () => await Promise.reject(new Error("network down")),
      onError: (error) => reported.push(error),
    });

    expect(duplicates).toEqual([]);
    expect(reported).toHaveLength(1);
  });

  test("a refusal the upload will meet anyway is not reported", async () => {
    const reported: Error[] = [];

    const duplicates = await resolveExactDuplicates({
      files: [fileWithHash("aaa")],
      hashFile: hashByName,
      lookup: async () =>
        await Promise.reject(
          new APIError({ status: 400, message: "Entities limit reached" }),
        ),
      onError: (error) => reported.push(error),
    });

    expect(duplicates).toEqual([]);
    expect(reported).toEqual([]);
  });

  test("a malformed request is still reported", async () => {
    const reported: Error[] = [];

    await resolveExactDuplicates({
      files: [fileWithHash("aaa")],
      hashFile: hashByName,
      lookup: async () =>
        await Promise.reject(
          new APIError({
            status: 400,
            code: API_VALIDATION_ERROR_CODE,
            message: "Invalid body",
          }),
        ),
      onError: (error) => reported.push(error),
    });

    expect(reported).toHaveLength(1);
  });

  test("a batch with nothing hashable never asks the matter", async () => {
    let lookups = 0;

    const duplicates = await resolveExactDuplicates({
      files: [fileWithHash("aaa")],
      hashFile: async () => await Promise.reject(new Error("too large")),
      lookup: async () => {
        lookups += 1;
        return await Promise.resolve([]);
      },
      onError: () => undefined,
    });

    expect(duplicates).toEqual([]);
    expect(lookups).toBe(0);
  });
});
