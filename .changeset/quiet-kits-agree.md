---
"stratasync": patch
---

Pin drizzle-kit to the build that matches the drizzle-orm release candidate in the scaffolded api. With the beta kit, `npm run db:push` exited 1 without creating any tables or printing an error, so the first `dev:api` failed on a missing table.
