---
name: scaffold-stratasync
description: Scaffold a complete Strata Sync app with Next.js client and Fastify server (models, sync, IndexedDB, WebSocket, PostgreSQL)
triggers:
  - scaffold stratasync
  - create stratasync app
  - new stratasync project
  - stratasync starter
  - setup stratasync
  - scaffold sync app
---

# Scaffold Strata Sync App

Scaffolds a complete local-first, server-sequenced sync app using Strata Sync. Produces a Next.js client and a standalone Fastify API server with PostgreSQL, ready to run in minutes.

## Reference files

| File                           | Purpose                                                                                             |
| ------------------------------ | --------------------------------------------------------------------------------------------------- |
| `references/client-setup.md`   | Next.js client: tsconfig, next.config, deps, model, client factory, providers, page                 |
| `references/server-setup.md`   | Fastify server: docker-compose, drizzle schema, server entry, config                                |
| `references/model-patterns.md` | Adding models, instance methods (.save/.delete/.archive), relations, load strategies, server config |

## Variables

| Variable               | Description                            | Default             |
| ---------------------- | -------------------------------------- | ------------------- |
| `{{PROJECT_NAME}}`     | Project directory and database name    | `my-stratasync-app` |
| `{{MODEL_NAME}}`       | Primary model name (PascalCase)        | `Todo`              |
| `{{MODEL_NAME_LOWER}}` | Model name (lowercase)                 | `todo`              |
| `{{MODEL_TABLE}}`      | Database table name (plural lowercase) | `todos`             |
| `{{API_PORT}}`         | Server port                            | `3001`              |
| `{{WEB_PORT}}`         | Client dev port                        | `3002`              |

---

## Workflow

### Phase 1: Gather info

- [ ] Ask for project name (default: `my-stratasync-app`)
- [ ] Ask for primary model name (default: `Todo`)
- [ ] Ask for model fields beyond defaults (`id`, `groupId`, `createdAt`)
- [ ] If user says "just defaults" or gives no specifics, use Todo with `title: string` and `completed: boolean`
- [ ] Derive `MODEL_NAME_LOWER` and `MODEL_TABLE` from `MODEL_NAME`

### Phase 2: Scaffold Next.js client

- [ ] Detect if inside an existing Next.js project (check for `next.config.*`)
- [ ] If no existing project: run `npx create-next-app@latest {{PROJECT_NAME}} --typescript --tailwind --eslint --app --src-dir --import-alias "@/*"` with `--use-npm`
- [ ] Install client dependencies per `references/client-setup.md` § Dependencies
- [ ] Merge tsconfig changes per `references/client-setup.md` § tsconfig. **`experimentalDecorators: true` is CRITICAL.**
- [ ] Write `next.config.ts` per `references/client-setup.md` § next.config. **`transpilePackages` is CRITICAL.**

### Phase 3: Scaffold server

- [ ] Create `server/` directory alongside the client
- [ ] Write all server files per `references/server-setup.md`:
  - `server/package.json`
  - `server/tsconfig.json`
  - `server/docker-compose.yml`
  - `server/.env.example`
  - `server/.env` (copy from `.env.example`)
  - `server/drizzle.config.ts`
  - `server/src/db/schema.ts`
  - `server/src/config.ts`
  - `server/src/server.ts`
- [ ] Run `cd server && npm install`

### Phase 4: Scaffold client sync layer

Write all client sync files per `references/client-setup.md`:

- [ ] `src/lib/sync/models/{{MODEL_NAME_LOWER}}.ts`: Model class with decorators
- [ ] `src/lib/sync/models.ts`: Barrel with side-effect import (**CRITICAL: decorator registration**)
- [ ] `src/lib/sync/config.ts`: API URL, dev tokens
- [ ] `src/lib/sync/create-client.ts`: Client factory with idempotent start
- [ ] `src/app/providers.tsx`: `NextSyncProvider` wrapper
- [ ] `src/app/layout.tsx`: Wrap children with `<Providers>`

### Phase 5: Scaffold example page

- [ ] Write `src/app/page.tsx` per `references/client-setup.md` § Example page
- [ ] Includes: create form, toggle, delete, sync status display
- [ ] Uses `useQuery`, `useSyncClient`, `useConnectionState`, `observer`, and instance `.save()` / `.delete()` methods
- [ ] All components marked `"use client"`

### Phase 6: Start and verify

- [ ] `cd server && docker compose up -d`: Start PostgreSQL
- [ ] `cd server && npm run db:push`: Create database tables
- [ ] `cd server && npm run dev`: Start API server (port {{API_PORT}})
- [ ] In a new terminal: `npm run dev`: Start Next.js (port {{WEB_PORT}})
- [ ] Verify: open `http://localhost:{{WEB_PORT}}`, create a todo, confirm it persists across refresh
- [ ] Verify: open a second tab, confirm real-time sync via WebSocket

---

## Anti-patterns

- **Never** omit `experimentalDecorators: true` from tsconfig. Decorators fail silently.
- **Never** omit `transpilePackages` from next.config. ESM imports break at runtime.
- **Never** forget side-effect model imports in the barrel file. Schema will be empty, no data syncs.
- **Never** install `@stratasync/server` in the client app. It is server-only.
- **Never** import `@stratasync/next` directly in client components. Use `@stratasync/next/client`.
- **Never** omit `"use client"` on components that use hooks
- **Never** use `React.forwardRef`. React 19+ passes ref as prop.
- **Never** skip the idempotent start wrapper. React StrictMode double-renders cause duplicate connections.

## Skill handoffs

| When                                  | Hand off to                                                   |
| ------------------------------------- | ------------------------------------------------------------- |
| User wants to add more models         | Refer to `references/model-patterns.md`                       |
| User wants authentication             | Beyond scaffold scope. Point to Strata Sync server auth docs. |
| User wants deployment                 | Beyond scaffold scope. Standard Next.js + Node.js deployment. |
| User wants collaborative text editing | Point to `@stratasync/y-doc` package                          |
