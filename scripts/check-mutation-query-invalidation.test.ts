import { expect, test } from "bun:test";

import {
  checkBaseline,
  inspectMutationQueryInvalidation,
} from "./check-mutation-query-invalidation.ts";
import { inspectMutationQuerySources } from "./mutation-query-census.ts";

const validSources = [
  {
    file: "packages/api-contract/src/resource-ref.ts",
    text: `export const RESOURCE_TYPE = { WORKSPACE: "workspace", ENTITY: "entity" } as const;`,
  },
  {
    file: "apps/web/src/lib/workspace-realtime.ts",
    text: `
import { RESOURCE_TYPE } from "@stll/api-contract";
export const resourceMutation = (options: { mutationFn: () => unknown }) => options.mutationFn;
export const resourceQueryOptions = (options: unknown) => options;
export const RESOURCE_MUTATION_CONTRACTS = {
  renameEntity: {
    writes: [{ method: "PATCH", route: "/entities/:workspaceId/rename" }],
    resources: [RESOURCE_TYPE.ENTITY],
  },
} as const;
`,
  },
  {
    file: "apps/web/src/lib/files/queries.ts",
    text: `
import { queryOptions } from "@tanstack/react-query";
import { RESOURCE_TYPE } from "@stll/api-contract";
import { resourceQueryOptions } from "@/lib/workspace-realtime";
export const fileOptions = (props: { id: string }) => resourceQueryOptions(
  queryOptions({ queryKey: ["file", props.id], queryFn: async () => props.id }),
  { resources: [RESOURCE_TYPE.ENTITY], scope: { type: "organization" } },
);
export const textFileOptions = (props: { id: string }) => resourceQueryOptions(
  queryOptions({ queryKey: ["text-file", props.id], queryFn: async () => props.id }),
  { resources: [RESOURCE_TYPE.ENTITY], scope: { type: "organization" } },
);
`,
  },
  {
    file: "apps/web/src/lib/files/file-metadata-query.ts",
    text: `
import { RESOURCE_TYPE } from "@stll/api-contract";
import { resourceQueryOptions } from "@/lib/workspace-realtime";
export const fileMetadataQueryOptions = (props: { id: string }) => resourceQueryOptions(
  { queryKey: ["file-metadata", props.id], queryFn: async () => props.id },
  { resources: [RESOURCE_TYPE.ENTITY], scope: { type: "organization" } },
);
export const fileMetadataOptions = fileMetadataQueryOptions;
`,
  },
  {
    file: "apps/web/src/features.ts",
    text: `
import { queryOptions } from "@tanstack/react-query";
import { useMutation } from "@tanstack/react-query";
import { resourceMutation, resourceQueryOptions } from "@/lib/workspace-realtime";
import { RESOURCE_TYPE } from "@stll/api-contract";
import { useQuery } from "@tanstack/react-query";
import { fileOptions, textFileOptions } from "@/lib/files/queries";
import { fileMetadataOptions } from "@/lib/files/file-metadata-query";
const queryClient = { prefetchQuery: (options: unknown) => options };
const api = { entities: (_args: { workspaceId: string }) => ({ rename: { patch: (input: unknown) => input }, delete: { patch: (input: unknown) => input } }) };
const renameEntityRequest = () => api.entities({ workspaceId: "123" }).rename.patch({ entityId: "123" });
export const saveWorkspace = () => useMutation({ mutationFn: resourceMutation({
  mutation: "renameEntity",
  queryClient,
  mutationFn: renameEntityRequest,
}) });
export const workspacesQuery = () => resourceQueryOptions(
  queryOptions({ queryKey: ["workspaces"], queryFn: async () => [] }),
  { resources: [RESOURCE_TYPE.WORKSPACE], scope: { type: "organization" } },
);
export const fileQuery = () => useQuery(fileOptions({ id: "file" }));
export const textFileQuery = () => useQuery(textFileOptions({ id: "text" }));
export const fileMetadataQuery = () => useQuery(fileMetadataOptions({ id: "meta" }));
const aliasedFileOptions = fileOptions({ id: "alias" });
const makeFileOptions = (id: string) => fileOptions({ id });
export const aliasedFileQuery = () => useQuery(aliasedFileOptions);
export const returnedFileQuery = () => useQuery(makeFileOptions("returned"));
export const prefetchedTextFile = () => queryClient.prefetchQuery(textFileOptions({ id: "prefetch" }));
const useRegisteredFileQuery = (id: string) => useQuery(fileOptions({ id }));
export const registeredFileQuery = () => useRegisteredFileQuery("registered");
`,
  },
];

const violations = (sources: typeof validSources) =>
  inspectMutationQueryInvalidation(
    inspectMutationQuerySources(sources),
    sources,
  );

const assertInvalidCannotBeBaselined = (
  findings: ReturnType<typeof violations>,
) => {
  const invalid = findings.filter(
    ({ disposition }) => disposition === "invalid-declaration",
  );
  expect(invalid.length).toBeGreaterThan(0);
  const recorded = Object.fromEntries(
    invalid.map(({ id, reason }) => [id, reason]),
  );
  expect(
    checkBaseline({
      observed: invalid,
      recorded,
      committed: recorded,
      write: true,
    }).ok,
  ).toBe(false);
};

test("the canonical mutation and reader helpers satisfy the AST guard", () => {
  expect(violations(validSources)).toEqual([]);
});

test("an unwrapped mutation fails the guard", () => {
  const wrongFixture = [
    ...validSources.slice(0, 2),
    {
      file: "apps/web/src/features.ts",
      text: `
import { useMutation } from "@tanstack/react-query";
const api = { workspaces: (_args: unknown) => ({ post: (input: unknown) => input }) };
export const saveWorkspace = () => useMutation({ mutationFn: () => api.workspaces({}).post({}) });
`,
    },
  ];
  expect(
    violations(wrongFixture).some(
      ({ file }) => file === "apps/web/src/features.ts",
    ),
  ).toBe(true);
});

test("an unknown resource member and a direct query factory fail the guard", () => {
  const wrongFixture = [
    ...validSources.slice(0, 2),
    {
      file: "apps/web/src/features.ts",
      text: `
import { queryOptions } from "@tanstack/react-query";
import { useMutation } from "@tanstack/react-query";
import { resourceMutation } from "@/lib/workspace-realtime";
const api = { workspaces: (_args: unknown) => ({ post: (input: unknown) => input }) };
export const saveWorkspace = () => useMutation({ mutationFn: resourceMutation({
  mutation: "unknownMutation",
  queryClient: {},
  mutationFn: () => api.workspaces({}).post({}),
}) });
export const workspacesQuery = () => queryOptions({ queryKey: ["workspaces"], queryFn: async () => [] });
`,
    },
  ];
  const findings = violations(wrongFixture);
  expect(findings).toHaveLength(2);
  const invalidMutation = findings.find(({ reason }) =>
    reason.includes("unknown contract"),
  );
  expect(invalidMutation?.disposition).toBe("invalid-declaration");
  assertInvalidCannotBeBaselined(findings);
});

test("a known contract cannot bless a different observed write route", () => {
  const wrongFixture = [
    ...validSources.slice(0, 2),
    {
      file: "apps/web/src/features.ts",
      text: `
import { resourceMutation } from "@/lib/workspace-realtime";
import { useMutation } from "@tanstack/react-query";
const api = { entities: (_args: { workspaceId: string }) => ({ delete: { patch: (input: unknown) => input } }) };
export const rename = () => useMutation({ mutationFn: resourceMutation({
  mutation: "renameEntity",
  queryClient: {},
  mutationFn: () => api.entities({ workspaceId: "123" }).delete.patch({ entityId: "123" }),
}) });
`,
    },
  ];
  const findings = violations(wrongFixture);
  expect(
    findings.filter(({ file }) => file === "apps/web/src/features.ts"),
  ).toHaveLength(1);
  assertInvalidCannotBeBaselined(findings);
});

test("every query reader kind must consume tagged options", () => {
  const wrongFixture = [
    ...validSources.slice(0, 2),
    {
      file: "apps/web/src/features.ts",
      text: `
import { useQuery } from "@tanstack/react-query";
const queryClient = { fetchQuery: (options: unknown) => options };
const inlineOptions = { queryKey: ["untagged"], queryFn: async () => [] };
const returnedOptions = () => ({ queryKey: ["unregistered"], queryFn: async () => [] });
export const directRead = () => queryClient.fetchQuery({ queryKey: ["direct"], queryFn: async () => [] });
export const aliasRead = () => useQuery(inlineOptions);
export const factoryRead = () => useQuery(returnedOptions());
`,
    },
  ];
  expect(
    violations(wrongFixture).filter(
      ({ file }) => file === "apps/web/src/features.ts",
    ),
  ).toHaveLength(3);
});

test("a new custom query wrapper cannot inherit an untagged reader definition", () => {
  const wrongFixture = [
    ...validSources.slice(0, 2),
    {
      file: "apps/web/src/features.ts",
      text: `
import { useQuery } from "@tanstack/react-query";
const usePlainQuery = (options: { queryKey: string[]; queryFn: () => Promise<unknown> }) => useQuery(options);
export const plainWrapperRead = () => usePlainQuery({ queryKey: ["plain"], queryFn: async () => [] });
`,
    },
  ];
  expect(
    violations(wrongFixture).filter(
      ({ file }) => file === "apps/web/src/features.ts",
    ),
  ).toHaveLength(2);
});

test("invalid resource reader metadata cannot be seeded into the baseline", () => {
  const wrongFixture = [
    ...validSources.slice(0, 2),
    {
      file: "apps/web/src/features.ts",
      text: `
import { queryOptions } from "@tanstack/react-query";
import { useQuery } from "@tanstack/react-query";
import { RESOURCE_TYPE } from "@stll/api-contract";
import { resourceQueryOptions } from "@/lib/workspace-realtime";
export const invalidQuery = () => useQuery(resourceQueryOptions(
  queryOptions({ queryKey: ["invalid"], queryFn: async () => [] }),
  { resources: [RESOURCE_TYPE.MISSING], scope: { type: "organization" } },
));
`,
    },
  ];
  const findings = violations(wrongFixture);
  const invalidHelper = findings.find(
    ({ disposition }) => disposition === "invalid-declaration",
  );
  expect(invalidHelper?.disposition).toBe("invalid-declaration");
  assertInvalidCannotBeBaselined(findings);
});

test("mutable helper aliases and caller-selected mutation scopes fail closed", () => {
  const wrongFixture = [
    ...validSources.slice(0, 2),
    {
      file: "apps/web/src/features.ts",
      text: `
import { resourceMutation } from "@/lib/workspace-realtime";
import { useMutation } from "@tanstack/react-query";
const api = { entities: (_args: { workspaceId: string }) => ({ rename: { patch: (input: unknown) => input } }) };
const fakeMutation = (options: { mutationFn: () => unknown }) => options.mutationFn;
let mutableMutation = resourceMutation;
mutableMutation = fakeMutation;
export const reassignedAlias = () => useMutation({ mutationFn: mutableMutation({
  mutation: "renameEntity",
  queryClient: {},
  mutationFn: () => api.entities({ workspaceId: "123" }).rename.patch({ entityId: "123" }),
}) });
export const callerScope = () => useMutation({ mutationFn: resourceMutation({
  mutation: "renameEntity",
  queryClient: {},
  scope: () => ({ type: "organization" }),
  mutationFn: () => api.entities({ workspaceId: "123" }).rename.patch({ entityId: "123" }),
}) });
export const spreadOptions = () => useMutation({ mutationFn: resourceMutation({
  ...{
    mutation: "renameEntity",
    queryClient: {},
    mutationFn: () => api.entities({ workspaceId: "123" }).rename.patch({ entityId: "123" }),
  },
}) });
`,
    },
  ];
  const findings = violations(wrongFixture);
  expect(
    findings.filter(({ file }) => file === "apps/web/src/features.ts"),
  ).toHaveLength(3);
  assertInvalidCannotBeBaselined(findings);
});

test("initial baseline seeding records a reason for each current site", () => {
  const disposition: "legacy" | "invalid-declaration" = "legacy";
  const finding = {
    id: "apps/web/src/a.ts:save:useMutation",
    file: "apps/web/src/a.ts",
    reason: "Pending migration.",
    disposition,
  };
  const observed = [finding];
  expect(
    checkBaseline({ observed, recorded: {}, committed: null, write: true }),
  ).toEqual({
    ok: true,
    entries: { [finding.id]: finding.reason },
    errors: [],
  });
});

test("duplicate observed finding IDs block baseline seeding", () => {
  const disposition: "legacy" | "invalid-declaration" = "legacy";
  const finding = {
    id: "apps/web/src/a.ts:read:useQuery:reader",
    file: "apps/web/src/a.ts",
    reason: "Pending migration.",
    disposition,
  };
  expect(
    checkBaseline({
      observed: [finding, finding],
      recorded: {},
      committed: null,
      write: true,
    }),
  ).toEqual({
    ok: false,
    entries: {},
    errors: [`Duplicate observed finding ID: ${finding.id}`],
  });
});

test("a committed baseline cannot gain sites or rewrite reasons, and can shrink", () => {
  const committed = {
    "apps/web/src/a.ts:save:useMutation": "Pending migration.",
  };
  const added = {
    ...committed,
    "apps/web/src/b.ts:save:useMutation": "Also pending.",
  };
  expect(
    checkBaseline({ observed: [], recorded: added, committed, write: true }).ok,
  ).toBe(false);
  expect(
    checkBaseline({
      observed: [],
      recorded: {
        ...committed,
        "apps/web/src/a.ts:save:useMutation": "Reworded.",
      },
      committed,
      write: true,
    }).ok,
  ).toBe(false);
  expect(
    checkBaseline({
      observed: [],
      recorded: committed,
      committed,
      write: true,
    }),
  ).toEqual({ ok: true, entries: {}, errors: [] });
});

test("check mode fails for new and stale entries", () => {
  const result = checkBaseline({
    observed: [
      {
        id: "apps/web/src/b.ts:save:useMutation",
        file: "apps/web/src/b.ts",
        reason: "Pending migration.",
        disposition: "legacy",
      },
    ],
    recorded: { "apps/web/src/a.ts:save:useMutation": "Pending migration." },
    committed: { "apps/web/src/a.ts:save:useMutation": "Pending migration." },
    write: false,
  });
  expect(result.ok).toBe(false);
  expect(result.errors).toEqual([
    "New unclassified site: apps/web/src/b.ts:save:useMutation",
    "Stale baseline entry: apps/web/src/a.ts:save:useMutation",
  ]);
});
