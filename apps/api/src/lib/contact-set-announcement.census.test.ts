import { describe, expect, test } from "bun:test";
import path from "node:path";

/**
 * Every write to the `contacts` table must tell the organization's open tabs
 * that its address book changed (`announceContactSetChanged`, after commit),
 * or other tabs keep showing contacts that were deleted or changed. A writer
 * either announces itself, is announced by the handler that commits its
 * transaction, or is exempt for a stated reason. A new writer fails here
 * until it picks one.
 */

const API_SRC = path.resolve(import.meta.dir, "..");
const WRITES_CONTACTS = /\.(?:insert|update|delete)\(contacts\)/u;
const ANNOUNCES = /\bannounceContactSetChanged\(/u;

/** Writers that run inside a caller's transaction: the caller announces. */
const ANNOUNCED_BY_CALLER: Record<string, string> = {
  "lib/imports/upsert-by-external-id.ts": "handlers/contacts/import.ts",
};

const EXEMPT: Record<string, string> = {
  "lib/member-assignment-offboarding.ts":
    "Clears a departing member's attorney assignment during offboarding; the field is not shown in contact lists.",
  "handlers/dev/routes.ts": "Development-only reset of a local organization.",
};

const isSource = (file: string) =>
  !file.endsWith(".test.ts") && !file.startsWith("tests/");

const readSource = async (file: string) =>
  await Bun.file(path.join(API_SRC, file)).text();

const contactWriters = async () => {
  const writers: string[] = [];
  for await (const file of new Bun.Glob("**/*.ts").scan(API_SRC)) {
    if (isSource(file) && WRITES_CONTACTS.test(await readSource(file))) {
      writers.push(file);
    }
  }
  return writers.toSorted();
};

describe("contact set announcements", () => {
  test("every contacts writer announces, is announced by its caller, or is exempt", async () => {
    const unannounced: string[] = [];
    for (const file of await contactWriters()) {
      if (Object.hasOwn(EXEMPT, file)) {
        continue;
      }
      const announcer = ANNOUNCED_BY_CALLER[file] ?? file;
      if (!ANNOUNCES.test(await readSource(announcer))) {
        unannounced.push(file);
      }
    }
    expect(unannounced).toEqual([]);
  });

  test("the census names only files that still write contacts", async () => {
    const writers = new Set(await contactWriters());
    const listed = [
      ...Object.keys(ANNOUNCED_BY_CALLER),
      ...Object.keys(EXEMPT),
    ];
    expect(listed.filter((file) => !writers.has(file))).toEqual([]);
  });
});
