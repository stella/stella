# Architecture

## System Overview

```
┌─────────────────┐     ┌─────────────────┐
│   Web App       │────▶│   API Server    │
│   React + Vite  │     │   Elysia + Bun  │
│   Port 3000     │     │   Port 3001     │
└─────────────────┘     └────────┬────────┘
                                 │
                    ┌────────────┼────────────┐
                    │            │            │
               ┌────▼────┐  ┌────▼────┐  ┌────▼────┐
               │Postgres │  │   S3    │  │   AI    │
               │ Drizzle │  │  Files  │  │ Google  │
               └─────────┘  └─────────┘  └─────────┘
```

## Monorepo

| Package                      | Purpose                                     |
| ---------------------------- | ------------------------------------------- |
| `apps/api`                   | Elysia backend — handlers, DB, auth, S3, AI |
| `apps/web`                   | React frontend — routes, components, state  |
| `packages/ui`                | Shared UI components (Base UI + Tailwind)   |
| `packages/rivet`             | Shared Rivet config and integration         |
| `packages/prettier-config`   | Shared Prettier config                      |
| `packages/typescript-config` | Shared TypeScript config                    |

## Data Model

Core tables in `apps/api/src/db/schema.ts`:

- **workspaces** — user workspaces within an organisation
- **files** — immutable file records (PDFs), tracked by sha256
- **properties** — data extraction rules/templates
- **propertyDependencies** — dependency graph between properties
- **entities** — data records within workspaces
- **fields** — property values for entities (linked to files)
- **justifications** — evidence supporting field values (HTML +
  bounding boxes)

Auth tables in `apps/api/src/db/auth-schema.ts` (better-auth):

- **users**, **sessions**, **accounts**, **verifications**
- **organizations**, **members**, **invitations**

## Key Patterns

- **API handlers**: `apps/api/src/handlers/{resource}/routes.ts`
- **Frontend routes**: `apps/web/src/routes/` (TanStack Router,
  auto-generated route tree)
- **State**: React Query for server state, Zustand for client state
- **Validation**: Zod on backend, Valibot on frontend
- **File flow**: client → presigned URL → S3 direct upload → DB
  record
- **AI flow**: documents → AI SDK (Google) → structured extraction
  → fields + justifications
