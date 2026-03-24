import { createFileRoute } from "@tanstack/react-router";

import GettingStartedPage from "../app/getting-started.js";

export const Route = createFileRoute("/getting-started")({
  component: GettingStartedPage,
});
