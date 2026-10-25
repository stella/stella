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
  { resources: [RESOURCE_TYPE.ENTITY], scope: props.workspaceId
    ? { type: "workspace", workspaceId: props.workspaceId }
    : { type: "organization" } },
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

const organizationWrites = [
  {
    type: "auth-plugin-endpoint",
    plugin: "organization",
    endpoint: "deleteOrganization",
    method: "POST",
    route: "/organization/delete",
  },
  {
    type: "auth-plugin-endpoint",
    plugin: "organization",
    endpoint: "leaveOrganization",
    method: "POST",
    route: "/organization/leave",
  },
];

const authPluginSources = ({
  operation,
  writes = organizationWrites,
  imported = 'import { authClient } from "@/lib/auth-client";',
  parameter = 'action: "delete" | "leave"',
}: {
  operation: string;
  writes?: typeof organizationWrites;
  imported?: string;
  parameter?: string;
}) => [
  ...validSources.slice(0, 2).map((source) => ({
    ...source,
    text: source.file.endsWith("resource-ref.ts")
      ? source.text.replace(
          'WORKSPACE: "workspace",',
          'ORGANIZATION: "organization", WORKSPACE: "workspace",',
        )
      : source.text.replace(
          "export const RESOURCE_MUTATION_CONTRACTS = {",
          () =>
            `export const RESOURCE_MUTATION_CONTRACTS = { deleteOrganization: { writes: ${JSON.stringify(writes)}, resources: [RESOURCE_TYPE.ORGANIZATION] },`,
        ),
  })),
  {
    file: "apps/web/src/features.ts",
    text: `
import { useMutation } from "@tanstack/react-query";
import { resourceMutation } from "@/lib/workspace-realtime";
${imported}
const queryClient = {};
export const removeOrganization = () => useMutation({
  mutationFn: resourceMutation({
    mutation: "deleteOrganization", queryClient, scope: { type: "organization" },
    mutationFn: async (${parameter}) => ${operation},
  }),
});`,
  },
];

test("auth plugin mutations use both actual RPC paths and their typed endpoint methods", () => {
  for (const client of ["authClient", "authAlias"]) {
    const sources = authPluginSources({
      imported: `import { authClient as ${client} } from "@/lib/auth-client";`,
      operation: `action === "delete" ? await ${client}.organization.delete({ organizationId }) : await ${client}.organization.leave({ organizationId })`,
    });
    const census = inspectMutationQuerySources(sources);
    expect(
      census.mutations
        .flatMap(({ writes }) =>
          writes.map(({ method, route }) => `${method} ${route}`),
        )
        .toSorted(),
    ).toEqual(["post /organization/delete", "post /organization/leave"]);
    expect(violations(sources)).toEqual([]);
  }
  expect(
    violations(
      authPluginSources({
        imported: 'import * as authNamespace from "@/lib/auth-client";',
        operation:
          'action === "delete" ? await authNamespace.authClient.organization.delete({ organizationId }) : await authNamespace.authClient.organization.leave({ organizationId })',
      }),
    ),
  ).toEqual([]);
});

test("auth plugin contracts cannot hide a missing conditional write or unknown receiver", () => {
  for (const sources of [
    authPluginSources({
      writes: organizationWrites.slice(0, 1),
      operation:
        'action === "delete" ? await authClient.organization.delete({ organizationId }) : await authClient.organization.leave({ organizationId })',
    }),
    authPluginSources({
      operation: "authClient.organization.destroy({ organizationId })",
    }),
    authPluginSources({
      parameter: "authClient: unknown",
      operation: "authClient.organization.delete({ organizationId })",
    }),
    authPluginSources({
      imported: 'import { authClient } from "@/lib/untrusted-client";',
      operation: "authClient.organization.delete({ organizationId })",
    }),
    authPluginSources({
      imported: 'import * as client from "@/lib/auth-client";',
      operation: "client.unknownClient.organization.delete({ organizationId })",
    }),
    authPluginSources({
      operation: "authClient.organization[endpointName]({ organizationId })",
    }),
  ]) {
    const census = inspectMutationQuerySources(sources);
    expect(
      census.mutations
        .flatMap(({ unresolved }) => unresolved)
        .some(({ reason }) => reason === "unresolved-auth-plugin-endpoint"),
    ).toBe(true);
    assertInvalidCannotBeBaselined(violations(sources));
  }
});

test("auth plugin route normalization covers declared camel-case RPC methods as a class", () => {
  for (const [member, route] of [
    ["updateMemberRole", "/organization/update-member-role"],
    ["inviteMember", "/organization/invite-member"],
    ["removeMember", "/organization/remove-member"],
    ["setActive", "/organization/set-active"],
  ] as const) {
    const sources = authPluginSources({
      writes: [
        {
          type: "auth-plugin-endpoint",
          plugin: "organization",
          endpoint: member,
          method: "POST",
          route,
        },
      ],
      operation: `authClient.organization.${member}({ organizationId })`,
    });
    expect(
      inspectMutationQuerySources(sources)
        .mutations.flatMap(({ writes }) => writes)
        .map(({ method, route: writeRoute }) => `${method} ${writeRoute}`),
    ).toEqual([`post ${route}`]);
    expect(violations(sources)).toEqual([]);
  }
});

test("chained query receivers preserve the executing reader call", () => {
  for (const receiver of [
    "useQueryClient()",
    "getClient()",
    "getClient().nested()",
  ]) {
    for (const method of ["fetchQuery", "ensureQueryData", "prefetchQuery"]) {
      const sources = [
        ...validSources.slice(0, 2),
        {
          file: "apps/web/src/features.ts",
          text: `
import { RESOURCE_TYPE } from "@stll/api-contract";
import { resourceQueryOptions } from "@/lib/workspace-realtime";
export const read = () => ${receiver}.${method}(resourceQueryOptions(
  { queryKey: ["reader"], queryFn: async () => [] },
  { resources: [RESOURCE_TYPE.ENTITY], scope: { type: "organization" } },
));`,
        },
      ];
      const census = inspectMutationQuerySources(sources);
      expect(
        census.readers.some(({ callee }) => callee === `${receiver}.${method}`),
      ).toBe(true);
      expect(inspectMutationQueryInvalidation(census, sources)).toEqual([]);
    }
  }
});

test("resource-independent readers require an explicit closed declaration", () => {
  for (const config of [
    { text: '{ type: "independent" }', valid: true },
    { text: "{ type: 'independent' }", valid: true },
    { text: '{ type: "unknown" }', valid: false },
    { text: '{ type: "independent", resources: [] }', valid: false },
    {
      text: '{ resources: [], scope: { type: "organization" } }',
      valid: false,
    },
  ]) {
    const sources = [
      ...validSources.slice(0, 2),
      {
        file: "apps/web/src/features.ts",
        text: `
import { queryOptions } from "@tanstack/react-query";
import { resourceQueryOptions } from "@/lib/workspace-realtime";
export const options = resourceQueryOptions(queryOptions({ queryKey: ["immutable"], queryFn: async () => [] }), ${config.text});`,
      },
    ];
    if (config.valid) {
      expect(violations(sources)).toEqual([]);
      continue;
    }
    assertInvalidCannotBeBaselined(violations(sources));
  }
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

test("custom query wrapper coverage requires tagged options to reach every reader", () => {
  const fixture = (wrapper: string) => [
    ...validSources.slice(0, 2),
    {
      file: "apps/web/src/features.ts",
      text: `
import { useQuery } from "@tanstack/react-query";
import { RESOURCE_TYPE } from "@stll/api-contract";
import { resourceQueryOptions } from "@/lib/workspace-realtime";
${wrapper}
const tagged = resourceQueryOptions(
  { queryKey: ["tagged"], queryFn: async () => [] },
  { resources: [RESOURCE_TYPE.ENTITY], scope: { type: "organization" } },
);
export const wrappedRead = () => useWrappedQuery(tagged);
`,
    },
  ];
  const ignoring = fixture(
    `const useWrappedQuery = (_options: unknown) => useQuery({ queryKey: ["plain"], queryFn: async () => [] });`,
  );
  const forwarding = fixture(
    `const useWrappedQuery = (options: unknown) => useQuery({ ...options, enabled: true });`,
  );
  const ignoringFindings = violations(ignoring).map(({ id }) => id);
  const forwardingFindings = violations(forwarding).map(({ id }) => id);
  const callerId =
    "apps/web/src/features.ts:wrappedRead:useWrappedQuery:reader";
  expect(ignoringFindings).toContain(callerId);
  expect(forwardingFindings).not.toContain(callerId);
  expect(forwardingFindings).toEqual([
    "apps/web/src/features.ts:useWrappedQuery:useQuery:reader",
  ]);
});

test("query wrappers lose coverage when their options parameter or aliases are mutated", () => {
  const fixture = (mutation: string) => [
    ...validSources.slice(0, 2),
    {
      file: "apps/web/src/features.ts",
      text: `
import { useQuery } from "@tanstack/react-query";
import { RESOURCE_TYPE } from "@stll/api-contract";
import { resourceQueryOptions } from "@/lib/workspace-realtime";
const useWrappedQuery = (options: unknown) => {
  const alias = options;
  ${mutation}
  return useQuery(options);
};
const tagged = resourceQueryOptions(
  { queryKey: ["tagged"], queryFn: async () => [] },
  { resources: [RESOURCE_TYPE.ENTITY], scope: { type: "organization" } },
);
export const wrappedRead = () => useWrappedQuery(tagged);
`,
    },
  ];
  for (const mutation of [
    'options = { queryKey: ["other"], queryFn: async () => [] };',
    "options.meta = {};",
    "alias.meta.resourceReads = undefined;",
  ]) {
    const findings = violations(fixture(mutation)).map(({ id }) => id);
    expect(findings).toContain(
      "apps/web/src/features.ts:wrappedRead:useWrappedQuery:reader",
    );
  }
});

test("query wrappers require every nested wrapper to forward tagged options", () => {
  const sources = [
    ...validSources.slice(0, 2),
    {
      file: "apps/web/src/features.ts",
      text: `
import { useQuery } from "@tanstack/react-query";
import { RESOURCE_TYPE } from "@stll/api-contract";
import { resourceQueryOptions } from "@/lib/workspace-realtime";
const useForwardingQuery = (options: unknown) => useQuery(options);
const useIgnoringQuery = (_options: unknown) => useQuery({ queryKey: ["plain"], queryFn: async () => [] });
const useBothQueries = (options: unknown) => {
  useForwardingQuery(options);
  return useIgnoringQuery();
};
const tagged = resourceQueryOptions(
  { queryKey: ["tagged"], queryFn: async () => [] },
  { resources: [RESOURCE_TYPE.ENTITY], scope: { type: "organization" } },
);
export const wrappedRead = () => useBothQueries(tagged);
`,
    },
  ];
  expect(violations(sources).map(({ id }) => id)).toContain(
    "apps/web/src/features.ts:wrappedRead:useBothQueries:reader",
  );
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

test("conditional reader scope is accepted only when both branches are valid", () => {
  const invalidFixture = [
    ...validSources.slice(0, 2),
    {
      file: "apps/web/src/features.ts",
      text: `
import { RESOURCE_TYPE } from "@stll/api-contract";
import { resourceQueryOptions } from "@/lib/workspace-realtime";
export const invalidQuery = () => resourceQueryOptions(
  { queryKey: ["invalid"], queryFn: async () => [] },
  { resources: [RESOURCE_TYPE.ENTITY], scope: isMatter
    ? { type: "workspace", workspaceId: "workspace" }
    : { type: "workspace" } },
);
`,
    },
  ];
  const findings = violations(invalidFixture);
  expect(
    findings.some(({ disposition }) => disposition === "invalid-declaration"),
  ).toBe(true);
  expect(violations(validSources)).toEqual([]);
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

test("only the executed mutationFn can satisfy the mutation contract", () => {
  const rawRequest = `const api = { entities: (_args: { workspaceId: string }) => ({ rename: { patch: (input: unknown) => input } }) };\nconst renameEntityRequest = () => api.entities({ workspaceId: "123" }).rename.patch({ entityId: "123" });`;
  const fixture = (body: string) => [
    ...validSources.slice(0, 2),
    {
      file: "apps/web/src/features.ts",
      text: `\nimport { resourceMutation } from "@/lib/workspace-realtime";\nimport { useMutation } from "@tanstack/react-query";\n${rawRequest}\n${body}\n`,
    },
  ];
  const invalidBodies = [
    `export const discarded = () => useMutation({ mutationFn: renameEntityRequest, onSuccess: () => resourceMutation({ mutation: "renameEntity", queryClient: {}, mutationFn: renameEntityRequest }) });`,
    `const wrapped = resourceMutation({ mutation: "renameEntity", queryClient: {}, mutationFn: renameEntityRequest });\nexport const overridden = () => useMutation({ ...{ mutationFn: wrapped }, mutationFn: renameEntityRequest });`,
    `const options = { mutationFn: resourceMutation({ mutation: "renameEntity", queryClient: {}, mutationFn: renameEntityRequest }) };\nconst alias = options;\nalias.mutationFn = renameEntityRequest;\nexport const mutatedAlias = () => useMutation(options);`,
    `const options = { mutationFn: resourceMutation({ mutation: "renameEntity", queryClient: {}, mutationFn: renameEntityRequest }) };\nlet alias = options;\nalias.mutationFn = renameEntityRequest;\nexport const mutatedLetAlias = () => useMutation(options);`,
  ];
  for (const body of invalidBodies) {
    const findings = violations(fixture(body));
    expect(
      findings.some(
        ({ file, disposition }) =>
          file === "apps/web/src/features.ts" &&
          disposition === "invalid-declaration",
      ),
    ).toBe(true);
    assertInvalidCannotBeBaselined(findings);
  }

  const unwrapped = violations(
    fixture(
      `const wrapped = resourceMutation({ mutation: "renameEntity", queryClient: {}, mutationFn: renameEntityRequest });\nexport const spreadFunction = () => useMutation({ ...wrapped });`,
    ),
  );
  expect(
    unwrapped.filter(({ file }) => file === "apps/web/src/features.ts"),
  ).toHaveLength(1);

  const covered = violations(
    fixture(
      `const wrapped = resourceMutation({ mutation: "renameEntity", queryClient: {}, mutationFn: renameEntityRequest });\nconst options = { mutationFn: wrapped };\nexport const covered = () => useMutation({ mutationFn: wrapped });\nexport const coveredSpread = () => useMutation({ ...options, onSuccess: () => {} });`,
    ),
  );
  expect(covered).toEqual([]);
});

test("mutation wrappers require empty owned writes and valid nested mutations", () => {
  const sources = [
    ...validSources.slice(0, 2),
    {
      file: "apps/web/src/wrappers.ts",
      text: `
import { useMutation } from "@tanstack/react-query";
import { resourceMutation } from "@/lib/workspace-realtime";
const api = { entities: (_args: { workspaceId: string }) => ({ rename: { patch: (input: unknown) => input }, delete: { delete: (input: unknown) => input } }) };
const renameEntityRequest = () => api.entities({ workspaceId: "123" }).rename.patch({ entityId: "123", name: "renamed" });
const renameMutation = resourceMutation({ mutation: "renameEntity", queryClient: {}, mutationFn: renameEntityRequest });
const useRegisteredRename = () => useMutation({ mutationFn: renameMutation });
const usePlainWrapper = () => useRegisteredRename();
const useDifferentRoute = () => { useRegisteredRename(); return api.entities({ workspaceId: "123" }).delete.delete({ entityId: "123" }); };
const useSameRequest = () => { useRegisteredRename(); return renameEntityRequest(); };
const useInvalidMiddle = () => { useRegisteredRename(); return renameEntityRequest(); };
const useOuter = () => useInvalidMiddle();
export const invokePlain = () => usePlainWrapper();
export const invokeDifferentRoute = () => useDifferentRoute();
export const invokeSameRequest = () => useSameRequest();
export const invokeOuter = () => useOuter();
`,
    },
  ];
  const census = inspectMutationQuerySources(sources);
  const findings = violations(sources);
  const wrapperEntry = (callee: string) =>
    census.mutations.find(
      (entry) => entry.kind === "wrapper" && entry.callee === callee,
    );
  const plain = wrapperEntry("usePlainWrapper");
  const differentRoute = wrapperEntry("useDifferentRoute");
  const sameRequest = wrapperEntry("useSameRequest");
  const middle = wrapperEntry("useInvalidMiddle");
  const outer = wrapperEntry("useOuter");
  expect(plain).toBeDefined();
  if (!plain) {
    return;
  }
  expect(differentRoute?.ownWrites).toHaveLength(1);
  expect(sameRequest?.ownWrites).toHaveLength(1);
  expect(middle?.ownWrites).toHaveLength(1);
  expect(outer?.ownWrites).toHaveLength(1);
  expect(findings.map(({ id }) => id)).not.toContain(`${plain.id}:mutation`);
  for (const entry of [differentRoute, sameRequest, middle, outer]) {
    expect(entry).toBeDefined();
    if (!entry) {
      continue;
    }
    expect(findings.map(({ id }) => id)).toContain(`${entry.id}:mutation`);
  }
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

test("reader options retain coverage only while every alias is untouched", () => {
  const fixture = (mutation: string) => [
    ...validSources.slice(0, 2),
    {
      file: "apps/web/src/features.ts",
      text: `
import { queryOptions, useQuery } from "@tanstack/react-query";
import { RESOURCE_TYPE } from "@stll/api-contract";
import { resourceQueryOptions } from "@/lib/workspace-realtime";
const options = resourceQueryOptions(
  queryOptions({ queryKey: ["entities"], queryFn: async () => [] }),
  { resources: [RESOURCE_TYPE.ENTITY], scope: { type: "organization" } },
);
const alias = options;
${mutation}
export const readEntities = () => useQuery(alias);
`,
    },
  ];
  expect(violations(fixture(""))).toEqual([]);
  for (const mutation of [
    "alias.meta = {};",
    "alias.meta.resourceReads = undefined;",
    "const metadata = options.meta; delete metadata.resourceReads;",
    "delete options.meta;",
    "Object.assign(options, { meta: {} });",
  ]) {
    const sources = fixture(mutation);
    const census = inspectMutationQuerySources(sources);
    const reader = census.readers.find(({ callee }) => callee === "useQuery");
    expect(reader).toBeDefined();
    if (!reader) {
      continue;
    }
    const findings = inspectMutationQueryInvalidation(census, sources);
    expect(findings.map(({ id }) => id)).toEqual([`${reader.id}:reader`]);
  }
});

test("tagged reader spreads allow only explicit non-computed overrides", () => {
  const fixture = (overrides: string) => [
    ...validSources.slice(0, 2),
    {
      file: "apps/web/src/features.ts",
      text: `
import { queryOptions, useQuery } from "@tanstack/react-query";
import { RESOURCE_TYPE } from "@stll/api-contract";
import { resourceQueryOptions } from "@/lib/workspace-realtime";
const options = resourceQueryOptions(
  queryOptions({ queryKey: ["entities"], queryFn: async () => [] }),
  { resources: [RESOURCE_TYPE.ENTITY], scope: { type: "organization" } },
);
export const readEntities = () => useQuery({ ...options, ${overrides} });
`,
    },
  ];
  for (const override of [
    '["meta"]: {}',
    '["enabled"]: false',
    "meta: {}",
    "retryFutureMode: true",
    "enabled: false, ...options",
    "...{ ...options, meta: {} }",
  ]) {
    const findings = violations(fixture(override));
    expect(findings.some(({ id }) => id.endsWith(":reader"))).toBe(true);
  }
  expect(violations(fixture("enabled: false"))).toEqual([]);
});

test("tagged mutation spreads use the same closed override rule", () => {
  const fixture = (overrides: string) => [
    ...validSources.slice(0, 2),
    {
      file: "apps/web/src/features.ts",
      text: `
import { resourceMutation } from "@/lib/workspace-realtime";
import { useMutation } from "@tanstack/react-query";
const api = { entities: (_args: { workspaceId: string }) => ({ rename: { patch: (input: unknown) => input } }) };
const renameEntityRequest = () => api.entities({ workspaceId: "123" }).rename.patch({ entityId: "123" });
const wrapped = resourceMutation({ mutation: "renameEntity", queryClient: {}, mutationFn: renameEntityRequest });
const options = { mutationFn: wrapped };
export const rename = () => useMutation({ ...options, ${overrides} });
`,
    },
  ];
  for (const override of [
    '["onSuccess"]: () => {}',
    '["meta"]: {}',
    "meta: true",
    "onSuccess: () => {}, ...options",
    "...{ ...options, ...{} }",
  ]) {
    const findings = violations(fixture(override));
    expect(
      findings.some(
        ({ file, disposition }) =>
          file === "apps/web/src/features.ts" &&
          disposition === "invalid-declaration",
      ),
    ).toBe(true);
    assertInvalidCannotBeBaselined(findings);
  }
  expect(violations(fixture("onSuccess: () => {}"))).toEqual([]);
});
