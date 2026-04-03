---
name: new-handler
description: 'Scaffold a new Elysia API handler following Stella''s conventions.'
---

# New Handler

Scaffold a new Elysia API handler following Stella's conventions.

## Arguments

$ARGUMENTS — The resource name and operations, e.g. "matters CRUD" or
"invoices list,create".

## Instructions

1. **Parse the arguments** to determine:
   - Resource name (singular, e.g. `matter`, `invoice`, `document`)
   - Operations needed (create, read, update, delete—use `-by-id`
     for singular-item actions, e.g. `read-by-id`, `update-by-id`, `delete-by-id`;
     or "CRUD" for all)

2. **Read existing handlers** to understand patterns:

   ```bash
   ls apps/api/src/handlers/
   ```

   Pick one handler directory and read its structure as a reference.

3. **Create the handler directory and files** at
   `apps/api/src/handlers/{resource}/`:
   - `index.ts` — Elysia plugin exporting all routes
   - One file per operation (e.g., `create.ts`, `read.ts`, `read-by-id.ts`,
     `update-by-id.ts`, `delete-by-id.ts`)

4. **Each handler must include**:
   - Input validation with Zod/Valibot schema
   - Authentication check
   - Workspace ownership verification (where applicable)
   - Drizzle ORM for database access
   - Proper error responses (not generic 500s)

5. **Follow these patterns**:
   - Route prefix: `/{resources}` (plural)
   - GET `/:id` for single resource
   - GET `/` for list (with query params for filtering)
   - POST `/` for create
   - PATCH `/:id` for update
   - DELETE `/:id` for delete
   - Return consistent response shapes

6. **Register the handler** in `apps/api/src/index.ts`:

   Add the import and `.use()` call following the existing pattern.

7. **Add tests** for functions that transform the data inside the route
   handler if they are complex enough. Do not add tests for database
   queries, Elysia route handlers, or macros.

8. **Run checks**:

   ```bash
   bun run typecheck && bun run lint && bun run test
   ```
