# web

Next.js app for the Strata Sync landing page.

## Development

From the repo root:

```bash
pnpm --filter web run dev
```

Or run all workspaces:

```bash
pnpm run dev
```

Open http://localhost:3000/stratasync (basePath `/stratasync`).

## Scripts

```bash
pnpm --filter web run build
pnpm --filter web run lint
pnpm --filter web run check-types
```

## Notes

- Uses pnpm workspaces and Node >= 22.
- App entry: `app/page.tsx`.
- Global styles: `app/globals.css`.
