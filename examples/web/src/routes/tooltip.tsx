import { createFileRoute } from "@tanstack/react-router";

import TooltipPage from "../app/tooltip.js";

export const Route = createFileRoute("/tooltip")({
  component: TooltipPage,
});
