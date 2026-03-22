# web

Next.js app for the Strata Sync landing page.

## Development

From the repo root:

```bash
npm run dev --workspace=web
```

Or run all workspaces:

```bash
npm run dev
```

Open http://localhost:3000.

## Scripts

```bash
npm run build --workspace=web
npm run lint --workspace=web
npm run check-types --workspace=web
```

## Notes

- Uses npm workspaces and Node >= 22.
- App entry: `app/page.tsx`.
- Global styles: `app/globals.css`.
