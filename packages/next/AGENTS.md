# @stratasync/next

Next.js integration helpers for App Router and Server Components.

## Commands

- `npm run build`: compile TypeScript (`tsc`)
- `npm run dev`: watch mode (`tsc --watch`)
- `npm run test`: run tests (`vitest run`)
- `npm run lint`: lint with Ultracite
- `npm run check-types`: type check without emitting

## Gotchas

- Next.js 14, 15, and 16 are supported via peer dependencies. Keep the range aligned with `package.json`.
- Package has separate entry points: root / `./client` for client code, and `./server` for server utilities. Prefer explicit subpaths in docs and examples.
- Server exports must not import client-only code (React hooks, browser APIs).
- Client exports must include `"use client"` directive when using React hooks.

## Conventions

- Server utilities go in `src/server/`, client utilities in `src/client/`.
- Use Next.js App Router patterns. No Pages Router support.
- Metadata helpers should use the App Router metadata API, not `next/head`.
