import { panic } from "better-result";
import { expect, test } from "bun:test";

import {
  checkBaseline,
  hookIdentities,
} from "./check-mutation-query-invalidation.ts";
import { inspectMutationQuerySources } from "./mutation-query-census.ts";

// A baseline entry may follow its hook when the code moves to another module
// or is renamed; the hook's identity, not its file or function, carries it.

test("a committed entry may move with its hook and reason, one for one", () => {
  const movedFrom = "apps/web/src/routes/a.tsx:RouteComponent:useQuery:reader";
  const committed = { [movedFrom]: "Pending migration." };
  // Moved to another module and renamed: only the hook's identity carries.
  const movedTo = "apps/web/src/routes/-a.page.tsx:APage:useQuery:reader";
  const reads = "reader\u0000useQuery\u0000viewsOptions\u0000";
  const finding = (id: string) => ({
    id,
    file: id.slice(0, id.indexOf(":")),
    reason: "Pending migration.",
    disposition: "legacy" as const,
  });
  const identities = {
    committed: new Map([[movedFrom, reads]]),
    current: new Map([[movedTo, reads]]),
  };
  expect(
    checkBaseline({
      observed: [finding(movedTo)],
      recorded: { [movedTo]: "Pending migration." },
      committed,
      write: false,
      identities,
    }),
  ).toEqual({
    ok: true,
    entries: { [movedTo]: "Pending migration." },
    errors: [],
  });
  // Without the identities nothing is a move.
  expect(
    checkBaseline({
      observed: [finding(movedTo)],
      recorded: { [movedTo]: "Pending migration." },
      committed,
      write: false,
    }).errors,
  ).toContain(`Added baseline entry: ${movedTo}`);
  // Kept under its old path as well, the entry is growth, not a move.
  expect(
    checkBaseline({
      observed: [finding(movedTo)],
      recorded: { ...committed, [movedTo]: "Pending migration." },
      committed,
      write: false,
      identities,
    }).errors,
  ).toContain(`Added baseline entry: ${movedTo}`);
  // A genuinely new entry, reading something else, still fails, even when
  // an entry left the baseline in the same change.
  const fresh = "apps/web/src/routes/-a.page.tsx:APage:useQuery#2:reader";
  expect(
    checkBaseline({
      observed: [finding(fresh)],
      recorded: { [fresh]: "Pending migration." },
      committed,
      write: false,
      identities: {
        committed: identities.committed,
        current: new Map([
          [fresh, "reader\u0000useQuery\u0000contactsOptions\u0000"],
        ]),
      },
    }).errors,
  ).toContain(`Added baseline entry: ${fresh}`);
  // The same hook under a new reason is not a move.
  expect(
    checkBaseline({
      observed: [finding(movedTo)],
      recorded: { [movedTo]: "Reworded." },
      committed,
      write: false,
      identities,
    }).errors,
  ).toContain(`Added baseline entry: ${movedTo}`);
  // One committed entry accounts for one moved entry.
  const second = "apps/web/src/routes/-b.page.tsx:BPage:useQuery:reader";
  expect(
    checkBaseline({
      observed: [finding(movedTo), finding(second)],
      recorded: {
        [movedTo]: "Pending migration.",
        [second]: "Pending migration.",
      },
      committed,
      write: false,
      identities: {
        committed: identities.committed,
        current: new Map([
          [movedTo, reads],
          [second, reads],
        ]),
      },
    }).ok,
  ).toBe(false);
});

test("hook identities name what a hook reads or writes, not where it sits", () => {
  const census = inspectMutationQuerySources([
    {
      file: "apps/web/src/a.tsx",
      text: `
import { queryOptions, useQuery } from "@tanstack/react-query";
const viewsOptions = () => queryOptions({ queryKey: ["views"], queryFn: async () => [] });
export function RouteComponent() { return useQuery(viewsOptions()); }
`,
    },
    {
      file: "apps/web/src/b.tsx",
      text: `
import { queryOptions, useQuery } from "@tanstack/react-query";
const viewsOptions = () => queryOptions({ queryKey: ["views"], queryFn: async () => [] });
const contactsOptions = () => queryOptions({ queryKey: ["contacts"], queryFn: async () => [] });
export function ViewPage() { return useQuery(viewsOptions()); }
export function ContactsPage() { return useQuery(contactsOptions()); }
`,
    },
  ]);
  const identities = hookIdentities(census);
  const readerOf = (file: string, scope: string) =>
    identities.get(
      [...identities.keys()].find(
        (id) => id.startsWith(`${file}:${scope}:`) && id.endsWith(":reader"),
      ) ?? panic(`no reader in ${file} ${scope}`),
    );
  expect(readerOf("apps/web/src/a.tsx", "RouteComponent")).toBe(
    readerOf("apps/web/src/b.tsx", "ViewPage"),
  );
  expect(readerOf("apps/web/src/b.tsx", "ContactsPage")).not.toBe(
    readerOf("apps/web/src/b.tsx", "ViewPage"),
  );
});
