/* eslint-disable react/no-danger -- shiki outputs pre-rendered HTML */
import {
  BoltIcon,
  EyeOpenIcon,
  HistoryIcon,
  LayersThreeIcon,
  OfflineIcon,
  PeopleIcon,
} from "blode-icons-react";
import { getSingletonHighlighter } from "shiki";

import { CopyButton } from "@/components/animate-ui/components/buttons/copy";
import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";
import { Button } from "@/components/ui/button";

const MODEL_SNIPPET = `import { ClientModel, Model, Property } from "@stratasync/core"

@ClientModel("Todo", { loadStrategy: "instant" })
class Todo extends Model {
  @Property() declare title: string
  @Property() declare completed: boolean
}`;

const CLIENT_SNIPPET = `import { createSyncClient } from "@stratasync/client"
import { createMobXReactivity } from "@stratasync/mobx"
import { createIndexedDbStorage } from "@stratasync/storage-idb"
import { GraphQLTransportAdapter } from "@stratasync/transport-graphql"

const client = createSyncClient({
  storage: createIndexedDbStorage(),
  transport: new GraphQLTransportAdapter({
    endpoint: "/api/sync",
    wsEndpoint: "wss://api.example.com/sync/ws",
  }),
  reactivity: createMobXReactivity(),
})`;

const HOOKS_SNIPPET = `import { useQuery, useSyncClient } from "@stratasync/react"

function TodoList() {
  const { data: todos } = useQuery("Todo", {
    where: (t) => !t.completed,
  })
  const { client } = useSyncClient()

  return (
    <ul>
      {todos.map((todo) => (
        <li key={todo.id}>{todo.title}</li>
      ))}
      <button onClick={() => client.create("Todo", {
        title: "New todo",
        completed: false,
      })}>
        Add
      </button>
    </ul>
  )
}`;

const features = [
  {
    description:
      "All reads come from a local IndexedDB replica. No spinners, no round-trips.",
    icon: BoltIcon,
    title: "Instant reads",
  },
  {
    description:
      "Mutations queue in a persistent outbox. Changes sync when you reconnect.",
    icon: OfflineIcon,
    title: "Offline support",
  },
  {
    description:
      "MobX makes each field observable. Only affected components re-render.",
    icon: EyeOpenIcon,
    title: "Fine-grained reactivity",
  },
  {
    description:
      "Yjs CRDT integration for multi-user editing of rich text and structured data.",
    icon: PeopleIcon,
    title: "Real-time collaboration",
  },
  {
    description:
      "Transaction-based history tracking, built into the sync client.",
    icon: HistoryIcon,
    title: "Undo and redo",
  },
  {
    description:
      "Swap storage, transport, or reactivity adapters. Use only what you need.",
    icon: LayersThreeIcon,
    title: "Modular",
  },
];

const highlighterOptions = {
  langs: ["bash", "tsx"],
  themes: ["github-light", "github-dark"],
};
let highlighterPromise: ReturnType<typeof getSingletonHighlighter> | null =
  null;

const getHighlighter = () => {
  if (!highlighterPromise) {
    highlighterPromise = getSingletonHighlighter(highlighterOptions);
  }
  return highlighterPromise;
};

const getCodeHtml = async (code: string, lang: "bash" | "tsx") => {
  const highlighter = await getHighlighter();
  return highlighter.codeToHtml(code, {
    lang,
    themes: {
      dark: "github-dark",
      light: "github-light",
    },
  });
};

const shikiClassName =
  "overflow-x-auto pb-4 text-xs md:text-sm [&>pre]:m-0 [&>pre]:p-0 [&>pre]:!bg-transparent [&>pre]:!font-mono [&>pre>code]:!font-mono dark:[&>pre]:!text-[color:var(--shiki-dark)] dark:[&>pre_span]:!text-[color:var(--shiki-dark)]";

const Home = async () => {
  const [modelHtml, clientHtml, hooksHtml] = await Promise.all([
    getCodeHtml(MODEL_SNIPPET, "tsx"),
    getCodeHtml(CLIENT_SNIPPET, "tsx"),
    getCodeHtml(HOOKS_SNIPPET, "tsx"),
  ]);

  return (
    <div className="flex min-h-screen flex-col">
      <SiteHeader />

      <main className="flex flex-1 flex-col">
        <div className="flex flex-1 flex-col">
          {/* Hero */}
          <div className="bg-linear-to-b from-white to-[#e8edda] dark:from-background dark:to-card">
            <section className="py-16 text-center md:py-24">
              <div className="container-wrapper">
                <h1 className="font-light font-sans text-6xl tracking-tight md:text-7xl">
                  Sync that works offline.
                </h1>
                <p className="mx-auto mt-4 max-w-150 text-balance text-center font-sans text-xl text-foreground/60 md:text-2xl">
                  A local-first sync engine for TypeScript, React, and Next.js.
                  Every read is instant. Every write works offline. Every client
                  converges.
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
              </div>
            </section>
          </div>

          {/* Features */}
          <section className="py-16">
            <div className="container-wrapper">
              <div className="mx-auto grid max-w-5xl gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {features.map((feature) => (
                  <div
                    className="rounded-2xl border bg-background/50 p-6"
                    key={feature.title}
                  >
                    <feature.icon className="mb-3 h-6 w-6 text-primary" />
                    <h3 className="font-semibold font-sans text-lg">
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

          {/* Code examples */}
          <section className="py-16">
            <div className="container-wrapper">
              <div className="mx-auto max-w-3xl space-y-10">
                <div className="space-y-3">
                  <h2 className="font-semibold font-sans text-xl tracking-tight">
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

                <div className="space-y-3">
                  <h2 className="font-semibold font-sans text-xl tracking-tight">
                    Create the client
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

                <div className="space-y-3">
                  <h2 className="font-semibold font-sans text-xl tracking-tight">
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
          </section>

          <SiteFooter />
        </div>
      </main>
    </div>
  );
};

export default Home;
