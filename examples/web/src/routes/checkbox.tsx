import { createFileRoute } from "@tanstack/react-router";

import CheckboxPage from "../app/checkbox.js";

export const Route = createFileRoute("/checkbox")({
  component: CheckboxPage,
});
