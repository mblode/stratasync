import { Outlet, createRootRoute } from "@tanstack/react-router";

import { Providers } from "../app/providers.js";

const RootLayout = () => (
  <Providers>
    <Outlet />
  </Providers>
);

export const Route = createRootRoute({
  component: RootLayout,
});
