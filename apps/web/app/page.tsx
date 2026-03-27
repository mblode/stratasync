/* eslint-disable react/no-danger -- shiki outputs pre-rendered HTML */
import { getSingletonHighlighter } from "shiki";

import { CopyButton } from "@/components/animate-ui/components/buttons/copy";
import { Showcase } from "@/components/demo/showcase";
import { LandingComparison } from "@/components/landing/landing-comparison";
import { LandingGap } from "@/components/landing/landing-gap";
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
                <p className="mx-auto mt-4 max-w-xl text-balance text-center font-sans text-xl text-white/75 md:text-2xl">
                  Inspired by Linear&#8217;s sync engine. Open-source.
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

          {/* WHY — problem + HOW — mechanism */}
          <LandingGap />

          {/* HOW — Comparison */}
          <LandingComparison />

          {/* WHAT — Interactive showcase */}
          <Showcase />

          {/* WHAT — Get started */}
          <section className="py-16 md:py-20">
            <div className="container-wrapper">
              <div className="mx-auto max-w-3xl space-y-10">
                <h2 className="mx-auto max-w-xl text-balance text-center font-sans text-3xl font-medium tracking-tight md:text-4xl">
                  Get started in minutes
                </h2>

                <div className="space-y-3">
                  <h3 className="font-medium text-muted-foreground text-sm">
                    1. Define your models ·{" "}
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
                    2. Create the client ·{" "}
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
                    3. Build reactive components ·{" "}
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
                  Open-source. No vendor lock-in.
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
