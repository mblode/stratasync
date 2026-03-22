import {
  ArrowUpDown,
  Database,
  Eye,
  Undo2,
  Users,
  WifiOff,
} from "lucide-react";
import { getSingletonHighlighter } from "shiki";

import { CopyButton } from "@/components/animate-ui/components/buttons/copy";
import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";
import { Button } from "@/components/ui/button";

const INSTALL_COMMAND =
  "npm install @stratasync/core @stratasync/client @stratasync/react";

const MODEL_SNIPPET = `import { ClientModel, Property, Model } from "@stratasync/core"

@ClientModel({ name: "Todo" })
class Todo extends Model {
  @Property() title = ""
  @Property() completed = false
}`;

const CLIENT_SNIPPET = `import { createSyncClient } from "@stratasync/client"
import { createIdbStorage } from "@stratasync/storage-idb"
import { createGraphQLTransport } from "@stratasync/transport-graphql"

const client = createSyncClient({
  storage: createIdbStorage({ name: "my-app" }),
  transport: createGraphQLTransport({ url: "/api/graphql" }),
})`;

const HOOKS_SNIPPET = `import { SyncProvider, useModel, useQuery } from "@stratasync/react"

function TodoList() {
  const todos = useQuery(Todo, { where: { completed: false } })

  return todos.map((todo) => (
    <TodoItem key={todo.id} todo={todo} />
  ))
}`;

const features = [
  {
    icon: Database,
    title: "Local-First Reads",
    description:
      "All data is read from a local IndexedDB replica. No network round-trips for rendering.",
  },
  {
    icon: ArrowUpDown,
    title: "Server-Sequenced",
    description:
      "The server assigns a monotonic syncId to every change, providing a single global ordering.",
  },
  {
    icon: Eye,
    title: "Observable Models",
    description:
      "MobX makes model instances observable. Sync deltas trigger fine-grained re-renders automatically.",
  },
  {
    icon: WifiOff,
    title: "Offline Support",
    description:
      "Mutations queue in a persistent outbox and replay when connectivity resumes. Fully offline-capable.",
  },
  {
    icon: Users,
    title: "Real-Time Collaboration",
    description:
      "Yjs CRDT integration enables multi-user collaborative editing of rich-text and structured documents.",
  },
  {
    icon: Undo2,
    title: "Undo / Redo",
    description:
      "Transaction-based undo and redo with full history tracking, built into the sync client.",
  },
];

const highlighterOptions = {
  themes: ["github-light", "github-dark"],
  langs: ["bash", "tsx"],
};
let highlighterPromise: ReturnType<typeof getSingletonHighlighter> | null =
  null;

const getHighlighter = () => {
  if (!highlighterPromise) {
    highlighterPromise = getSingletonHighlighter(highlighterOptions);
  }
  return highlighterPromise;
};

async function getCodeHtml(code: string, lang: "bash" | "tsx") {
  const highlighter = await getHighlighter();
  return highlighter.codeToHtml(code, {
    lang,
    themes: {
      light: "github-light",
      dark: "github-dark",
    },
  });
}

const shikiClassName =
  "overflow-x-auto pb-4 text-xs md:text-sm [&>pre]:m-0 [&>pre]:p-0 [&>pre]:!bg-transparent [&>pre]:!font-mono [&>pre>code]:!font-mono dark:[&>pre]:!text-[color:var(--shiki-dark)] dark:[&>pre_span]:!text-[color:var(--shiki-dark)]";

export default async function Home() {
  const [installHtml, modelHtml, clientHtml, hooksHtml] = await Promise.all([
    getCodeHtml(INSTALL_COMMAND, "bash"),
    getCodeHtml(MODEL_SNIPPET, "tsx"),
    getCodeHtml(CLIENT_SNIPPET, "tsx"),
    getCodeHtml(HOOKS_SNIPPET, "tsx"),
  ]);

  return (
    <div className="flex min-h-screen flex-col">
      <SiteHeader />

      <main className="flex flex-1 flex-col">
        <div className="flex flex-1 flex-col">
          <div className="bg-linear-to-b from-white to-[#f7ecd2] dark:from-background dark:to-card">
            <section className="py-16 text-center md:py-24">
              <div className="container-wrapper">
                <h1 className="font-light font-serif text-7xl tracking-tight">
                  Strata Sync
                </h1>
                <p className="mx-auto mt-4 max-w-150 text-balance text-center font-serif text-2xl text-foreground/60 md:text-3xl">
                  Local-first, server-sequenced sync for TypeScript, React, and
                  Next.js
                </p>

                <div className="mt-8 flex flex-wrap items-center justify-center gap-4">
                  <Button asChild size="lg">
                    <a href="https://stratasync.dev/docs">Get started</a>
                  </Button>

                  <Button asChild size="lg" variant="outline">
                    <a href="https://github.com/stratasync/stratasync">
                      GitHub
                    </a>
                  </Button>
                </div>

                <code className="relative mt-8 inline-flex items-center gap-2 font-mono text-sm">
                  <div className="max-w-125 truncate">
                    npm install @stratasync/core @stratasync/client
                    @stratasync/react
                  </div>
                  <CopyButton
                    content="npm install @stratasync/core @stratasync/client @stratasync/react"
                    size="xs"
                    variant="ghost"
                  />
                </code>
              </div>
            </section>

            <section className="pb-16">
              <div className="container-wrapper">
                <div className="mx-auto grid max-w-5xl gap-4 sm:grid-cols-2 lg:grid-cols-3">
                  {features.map((feature) => (
                    <div
                      className="rounded-2xl border bg-background/50 p-6 backdrop-blur"
                      key={feature.title}
                    >
                      <feature.icon className="mb-3 h-6 w-6 text-primary" />
                      <h3 className="font-semibold font-serif text-lg">
                        {feature.title}
                      </h3>
                      <p className="mt-1 text-muted-foreground text-sm">
                        {feature.description}
                      </p>
                    </div>
                  ))}
                </div>
              </div>
            </section>
          </div>

          <section className="pb-16">
            <div className="container-wrapper">
              <div className="mx-auto max-w-5xl">
                <div className="mt-16 space-y-10">
                  <div className="space-y-4">
                    <h2 className="font-semibold font-serif text-2xl text-foreground tracking-tight">
                      Installation
                    </h2>
                    <div className="relative rounded-2xl bg-muted/50 p-4 pr-14 pb-0">
                      <CopyButton
                        className="absolute top-3 right-3"
                        content={INSTALL_COMMAND}
                        size="xs"
                        variant="ghost"
                      />
                      <div
                        className={shikiClassName}
                        dangerouslySetInnerHTML={{ __html: installHtml }}
                      />
                    </div>
                  </div>

                  <div className="space-y-4">
                    <h2 className="font-semibold font-serif text-2xl text-foreground tracking-tight">
                      Define your models
                    </h2>
                    <div className="relative rounded-2xl bg-muted/50 p-4 pr-14 pb-0">
                      <CopyButton
                        className="absolute top-3 right-3"
                        content={MODEL_SNIPPET}
                        size="xs"
                        variant="ghost"
                      />
                      <div
                        className={shikiClassName}
                        dangerouslySetInnerHTML={{ __html: modelHtml }}
                      />
                    </div>
                  </div>

                  <div className="space-y-4">
                    <h2 className="font-semibold font-serif text-2xl text-foreground tracking-tight">
                      Create the sync client
                    </h2>
                    <div className="relative rounded-2xl bg-muted/50 p-4 pr-14 pb-0">
                      <CopyButton
                        className="absolute top-3 right-3"
                        content={CLIENT_SNIPPET}
                        size="xs"
                        variant="ghost"
                      />
                      <div
                        className={shikiClassName}
                        dangerouslySetInnerHTML={{ __html: clientHtml }}
                      />
                    </div>
                  </div>

                  <div className="space-y-4">
                    <h2 className="font-semibold font-serif text-2xl text-foreground tracking-tight">
                      Use React hooks
                    </h2>
                    <div className="relative rounded-2xl bg-muted/50 p-4 pr-14 pb-0">
                      <CopyButton
                        className="absolute top-3 right-3"
                        content={HOOKS_SNIPPET}
                        size="xs"
                        variant="ghost"
                      />
                      <div
                        className={shikiClassName}
                        dangerouslySetInnerHTML={{ __html: hooksHtml }}
                      />
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </section>

          <SiteFooter />
        </div>
      </main>
    </div>
  );
}
