import { createFileRoute } from "@tanstack/react-router";

import ExamplePage from "../app/page.js";

export const Route = createFileRoute("/")({
  component: ExamplePage,
});
