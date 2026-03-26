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
import { Showcase } from "@/components/demo/showcase";
import { LandingComparison } from "@/components/landing/landing-comparison";
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
    endpoint: "/api/graphql",
    syncEndpoint: "/api/sync",
    wsEndpoint: "wss://api.example.com/sync/ws",
    auth: { getAccessToken: async () => "token" },
  }),
  reactivity: createMobXReactivity(),
})`;

const HOOKS_SNIPPET = `import { observer } from "mobx-react-lite"
import { useQuery, useSyncClient } from "@stratasync/react"

const TodoList = observer(() => {
  const { data: todos } = useQuery("Todo", {
    where: (t) => !t.completed,
  })
  const { client } = useSyncClient()

  const addTodo = async () => {
    const todo = await client.create("Todo", {
      title: "New todo",
      completed: false,
    })
    todo.title = "Actually, a better title"
    await todo.save()
  }

  return (
    <ul>
      {todos.map((todo) => (
        <li key={todo.id}>{todo.title}</li>
      ))}
      <button onClick={addTodo}>Add</button>
    </ul>
  )
})`;

const features = [
  {
    description:
      "All reads come from a local IndexedDB replica. No spinners, no round-trips.",
    icon: BoltIcon,
    title: "Instant reads",
  },
  {
    description:
      "Writes queue offline and sync when you reconnect. Nothing is lost.",
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
      "Multiple users can edit the same document at the same time with Yjs.",
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
      <main className="flex flex-1 flex-col">
        <div className="flex flex-1 flex-col">
          {/* WHY — Hero */}
          <div className="bg-[#2E6F40] text-white">
            <SiteHeader />
            <section className="py-16 text-center md:py-32">
              <div className="container-wrapper">
                <h1 className="font-light font-sans text-6xl tracking-tight md:text-7xl">
                  Apps that just work.
                </h1>
                <p className="mx-auto mt-4 max-w-xl text-balance text-center font-sans text-xl text-white/60 md:text-2xl">
                  Instant. Collaborative. Offline. The sync engine your users
                  expect and your codebase deserves.
                </p>

                <div className="mt-8 flex flex-wrap items-center justify-center gap-4">
                  <Button
                    asChild
                    className="border-white bg-clip-border bg-white text-[#2E6F40] hover:bg-white/90 active:bg-white/95"
                    size="lg"
                  >
                    <a href="https://stratasync.dev/docs">Get started</a>
                  </Button>
                  <Button
                    asChild
                    className="border-white bg-clip-border bg-transparent text-white hover:bg-white/10 active:bg-white/20"
                    size="lg"
                    variant="outline"
                  >
                    <a href="https://github.com/stratasync/stratasync">
                      GitHub
                    </a>
                  </Button>
                </div>

                <code className="relative mt-8 inline-flex items-center gap-2 font-mono text-sm">
                  <div className="max-w-100 truncate">
                    npx skills add stratasync/stratasync
                  </div>
                  <CopyButton
                    content="npx skills add stratasync/stratasync"
                    size="xs"
                    variant="ghost"
                  />
                </code>
              </div>
            </section>
          </div>

          {/* WHY — The Problem */}
          <section className="py-16 md:py-24">
            <div className="container-wrapper">
              <div className="mx-auto max-w-3xl space-y-6 text-center">
                <h2 className="text-balance font-sans text-3xl font-medium tracking-tight md:text-4xl">
                  Why are modern apps so hard to build?
                </h2>
                <div className="space-y-4 text-lg text-muted-foreground">
                  <p className="text-balance">
                    Users expect instant interactions. They expect apps to work
                    on a train, on a plane, on spotty hotel Wi-Fi. They expect
                    their edits to merge seamlessly with their teammates&#8217;.
                  </p>
                  <p className="text-balance">
                    But delivering that experience means wrestling with caching
                    layers, conflict resolution, optimistic updates, retry
                    queues, and WebSocket plumbing.
                  </p>
                  <p className="text-balance">
                    Most teams spend months building infrastructure instead of
                    features.
                  </p>
                </div>
              </div>
            </div>
          </section>

          {/* WHY — The Tension */}
          <section className="bg-muted/30 py-16 md:py-20">
            <div className="container-wrapper">
              <div className="mx-auto max-w-4xl space-y-8">
                <h2 className="text-center font-sans text-xl font-semibold tracking-tight">
                  User expectations vs. developer reality
                </h2>
                <div className="grid gap-8 sm:grid-cols-2">
                  <div className="space-y-4">
                    <h3 className="font-sans text-sm font-semibold uppercase tracking-wider">
                      What users want
                    </h3>
                    <ul className="space-y-3 font-medium text-foreground">
                      <li>Instant interactions, no spinners</li>
                      <li>Works offline without thinking about it</li>
                      <li>Real-time collaboration that just merges</li>
                      <li>Never lose my work</li>
                    </ul>
                  </div>
                  <div className="space-y-4">
                    <h3 className="font-sans text-sm font-semibold uppercase tracking-wider text-muted-foreground">
                      What developers build
                    </h3>
                    <ul className="space-y-3 text-muted-foreground">
                      <li>Loading states, skeleton screens, retry logic</li>
                      <li>
                        Service workers, cache invalidation, queue management
                      </li>
                      <li>Conflict resolution algorithms, CRDT research</li>
                      <li>Transaction logs, undo stacks, backup strategies</li>
                    </ul>
                  </div>
                </div>
              </div>
            </div>
          </section>

          {/* HOW — The Bridge */}
          <section className="py-16 md:py-24">
            <div className="container-wrapper">
              <div className="mx-auto max-w-2xl space-y-4 text-center">
                <h2 className="text-balance font-sans text-3xl font-medium tracking-tight md:text-4xl">
                  There&#8217;s a better architecture.
                </h2>
                <p className="text-balance text-lg text-muted-foreground">
                  Local-first sync puts a replica of your database on every
                  device. Reads are instant. Writes work offline. Collaboration
                  is built-in. Strata Sync makes it easy.
                </p>
              </div>
            </div>
          </section>

          {/* HOW — Feature Grid */}
          <section className="py-16 md:py-20">
            <div className="container-wrapper">
              <div className="mx-auto max-w-5xl space-y-8">
                <h2 className="text-center font-semibold font-sans text-xl tracking-tight">
                  How it works
                </h2>
                <div className="grid gap-x-8 gap-y-10 sm:grid-cols-2 lg:grid-cols-3">
                  {features.map((feature) => (
                    <div key={feature.title}>
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
            </div>
          </section>

          {/* HOW — Comparison */}
          <LandingComparison />

          {/* WHAT — Interactive showcase */}
          <Showcase />

          {/* WHAT — Get started */}
          <section className="py-16 md:py-20">
            <div className="container-wrapper">
              <div className="mx-auto max-w-3xl space-y-10">
                <h2 className="text-center font-semibold font-sans text-xl tracking-tight">
                  Get started in minutes
                </h2>

                <div className="space-y-3">
                  <h3 className="font-medium text-muted-foreground text-sm">
                    1. Define your models &mdash;{" "}
                    <code className="text-xs opacity-60">
                      lib/sync/models.ts
                    </code>
                  </h3>
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
                  <h3 className="font-medium text-muted-foreground text-sm">
                    2. Create the client &mdash;{" "}
                    <code className="text-xs opacity-60">
                      lib/sync/client.ts
                    </code>
                  </h3>
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
                  <h3 className="font-medium text-muted-foreground text-sm">
                    3. Build reactive components &mdash;{" "}
                    <code className="text-xs opacity-60">
                      components/todo-list.tsx
                    </code>
                  </h3>
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

                <p className="text-center">
                  <Button asChild variant="link">
                    <a
                      href="https://github.com/stratasync/stratasync/tree/main/examples"
                      rel="noopener noreferrer"
                      target="_blank"
                    >
                      View full examples on GitHub
                    </a>
                  </Button>
                </p>
              </div>
            </div>
          </section>

          {/* Final CTA */}
          <section className="py-16 md:py-32">
            <div className="container-wrapper">
              <div className="mx-auto max-w-3xl text-center">
                <h2 className="text-balance font-sans text-4xl font-medium tracking-tight">
                  Ready to build apps that just work?
                </h2>
                <p className="mx-auto mt-4 max-w-xl text-balance text-muted-foreground">
                  Add local-first sync to your app in minutes. Open-source. No
                  vendor lock-in.
                </p>
                <div className="mt-6 flex flex-wrap justify-center gap-3">
                  <Button asChild size="lg">
                    <a href="https://stratasync.dev/docs">Get started</a>
                  </Button>
                  <Button asChild size="lg" variant="secondary">
                    <a href="https://github.com/stratasync/stratasync">
                      GitHub
                    </a>
                  </Button>
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
