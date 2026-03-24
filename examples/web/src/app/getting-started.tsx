import { Callout } from "@/components/ui/callout.js";
import { Steps } from "@/components/ui/steps.js";

const GettingStartedPage = () => (
  <main className="mx-auto max-w-2xl px-4 py-12">
    <h1 className="mb-6 text-2xl font-semibold">Getting Started</h1>

    <Callout className="mb-8">
      <p>
        <strong>Note:</strong> Blode UI is a third-party shadcn registry hosted
        at{" "}
        <a
          href="https://ui.blode.co"
          className="font-medium underline underline-offset-4"
          target="_blank"
          rel="noreferrer"
        >
          ui.blode.co
        </a>
        . The setup flow is the same as{" "}
        <a
          href="https://ui.shadcn.com/docs/installation/"
          className="font-medium underline underline-offset-4"
          target="_blank"
          rel="noreferrer"
        >
          shadcn/ui
        </a>{" "}
        with one extra step: add the registry namespace.
      </p>
    </Callout>

    <Steps>
      <h3>Create or initialize a project</h3>
      <pre className="mb-6 overflow-x-auto rounded-lg bg-primary px-4 py-3 text-sm text-primary-foreground">
        <code>npx shadcn@latest init</code>
      </pre>

      <h3>Add the Blode registry</h3>
      <pre className="mb-6 overflow-x-auto rounded-lg bg-primary px-4 py-3 text-sm text-primary-foreground">
        <code>
          {
            "npx shadcn@latest registry add @blode=https://ui.blode.co/r/{name}.json"
          }
        </code>
      </pre>

      <h3>Add a component</h3>
      <pre className="mb-6 overflow-x-auto rounded-lg bg-primary px-4 py-3 text-sm text-primary-foreground">
        <code>npx shadcn@latest add @blode/button</code>
      </pre>

      <h3>Import component</h3>
      <p className="mb-3 text-sm text-muted-foreground">
        The command above will add the{" "}
        <code className="rounded bg-secondary px-1.5 py-0.5 text-xs font-medium">
          Button
        </code>{" "}
        component to your project. You can then import it like this:
      </p>
      <pre className="mb-6 overflow-x-auto rounded-lg bg-primary px-4 py-3 text-sm text-primary-foreground">
        <code>
          {`import { Button } from "@/components/ui/button";

export default function Home() {
  return <Button>Click me</Button>;
}`}
        </code>
      </pre>
    </Steps>
  </main>
);

export default GettingStartedPage;
