import { siteConfig } from "@/lib/config";

// Markdown rendering of the homepage, served to clients that request
// `Accept: text/markdown` (routed here by middleware.ts). This mirrors the
// structure of app/page.tsx so agents receive the same information as
// browsers, without the surrounding presentation markup.

const CACHE_FIVE_MINUTES = "public, max-age=300, stale-while-revalidate=3600";

const MARKDOWN_BODY = `# ${siteConfig.name}

> Apps that just work. Inspired by Linear's sync engine. Open-source.

${siteConfig.description}

## Links

- Documentation: ${siteConfig.url}/docs
- GitHub: ${siteConfig.links.github}
- API catalog: ${siteConfig.url}/.well-known/api-catalog
- Agent skills: ${siteConfig.url}/.well-known/agent-skills/index.json

## Install

\`\`\`bash
npx skills add stratasync/stratasync
\`\`\`

## Quick start

### 1. Define your models (\`lib/sync/models.ts\`)

\`\`\`ts
import { ClientModel, Model, Property } from "@stratasync/core"

@ClientModel("Todo", { loadStrategy: "instant" })
class Todo extends Model {
  @Property() declare title: string
  @Property() declare completed: boolean
}
\`\`\`

### 2. Create the client (\`lib/sync/client.ts\`)

\`\`\`ts
import { createSyncClient } from "@stratasync/client"
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
})
\`\`\`

### 3. Build reactive components (\`components/todo-list.tsx\`)

\`\`\`tsx
import { observer } from "mobx-react-lite"
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
})
\`\`\`

## Examples

Full examples: ${siteConfig.links.github}/tree/main/examples
`;

export const GET = () =>
  new Response(MARKDOWN_BODY, {
    headers: {
      "Cache-Control": CACHE_FIVE_MINUTES,
      "Content-Type": "text/markdown; charset=utf-8",
      Vary: "Accept",
    },
  });
