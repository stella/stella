# `@stll/auth-model`

Portable Better Auth contracts for applications that need identical identity,
session, account, verification, organization, membership, invitation, and role
semantics. The package has no database or framework runtime dependency.

The parity manifest pins:

- the Better Auth version and singular core model names;
- PostgreSQL, snake-case mappings, singular model names, transactional adapters,
  application-generated string IDs, database-backed session/verification, and
  timezone-aware timestamps;
- separate logical and physical field semantics: required/not-null, defaults,
  update behavior, input/output ownership, sorting, indexes, uniqueness,
  references, physical names/types, primary keys, and exact index predicates;
- the organization plugin options and core role grants.

Hosts own runtime tables, adapters, secrets, email delivery, lifecycle hooks, and
product permissions. Every additional field, index, or plugin model must be
declared explicitly when comparing the normalized host schema.

```ts
import {
  BETTER_AUTH_ADAPTER_OPTIONS,
  BETTER_AUTH_ORGANIZATION_OPTIONS,
  BETTER_AUTH_ORGANIZATION_ROLE_GRANTS,
  BETTER_AUTH_ORGANIZATION_STATEMENTS,
} from "@stll/auth-model";
import { createAccessControl } from "better-auth/plugins/access";

const statements = {
  ...BETTER_AUTH_ORGANIZATION_STATEMENTS,
  document: ["read", "create", "update", "delete"],
} as const;
const ac = createAccessControl(statements);

const owner = ac.newRole({
  ...BETTER_AUTH_ORGANIZATION_ROLE_GRANTS.owner,
  document: ["read", "create", "update", "delete"],
});

const adapterOptions = {
  provider: "pg",
  schema,
  ...BETTER_AUTH_ADAPTER_OPTIONS,
};
const organizationOptions = {
  ...BETTER_AUTH_ORGANIZATION_OPTIONS,
  ac,
  roles: { owner },
};
```

`compareBetterAuthSchema` accepts a normalized schema and an exact extension
allowlist. It reports `incompatible` for missing core models or fields, semantic
drift, undeclared additions, and stale extension declarations. Record and index
declaration order do not affect the result; index column order remains semantic.

The package intentionally does not export runtime tables, secrets, email
implementations, lifecycle hooks, or product-specific resources.
