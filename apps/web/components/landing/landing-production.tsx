import { siteConfig } from "@/lib/config";

/**
 * The one production deployment, named. Six clients converging over the same
 * bootstrap/delta/mutate protocol is the proof that the server-sequenced log
 * holds up outside a demo; the iOS row is a Swift port of the protocol, not
 * these npm packages, and the copy says so rather than rounding up.
 */
const clients = [
  { name: "Web dashboard", stack: "React 19, MobX, IndexedDB" },
  { name: "Desktop", stack: "Tauri 2 shell" },
  { name: "iOS", stack: "SwiftUI, Swift port of the protocol" },
  { name: "CLI", stack: "npm package, OAuth" },
  { name: "Raycast", stack: "macOS launcher extension" },
  { name: "MCP server", stack: "Hosted, for AI agents" },
];

export const LandingProduction = () => (
  <section className="py-16 md:py-20" id="production">
    <div className="container-wrapper">
      <div className="mx-auto max-w-4xl space-y-8">
        <div className="space-y-4">
          <h2 className="mx-auto max-w-xl text-balance text-center font-sans text-3xl font-medium tracking-tight md:text-4xl">
            In production at Done Bear
          </h2>
          <p className="mx-auto max-w-2xl text-balance text-center text-muted-foreground">
            <a
              className="underline underline-offset-2 hover:text-foreground"
              href={siteConfig.links.doneBear}
              rel="noopener noreferrer"
              target="_blank"
            >
              Done Bear
            </a>{" "}
            is a task manager by the same author. Six clients read and write one
            Postgres through Strata Sync&#8217;s bootstrap, delta and mutate
            endpoints, and every one of them converges on the same
            server-ordered log.
          </p>
        </div>

        <ul className="grid grid-cols-2 gap-3 md:grid-cols-3">
          {clients.map((client) => (
            <li
              className="rounded-2xl border border-border bg-card px-4 py-3.5"
              key={client.name}
            >
              <p className="font-sans text-sm font-semibold">{client.name}</p>
              <p className="mt-0.5 text-muted-foreground text-xs">
                {client.stack}
              </p>
            </li>
          ))}
        </ul>
      </div>
    </div>
  </section>
);
