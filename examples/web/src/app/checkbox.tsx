import { CheckboxDemo } from "@/components/demos/checkbox-demo.js";
import { CheckboxDisabled } from "@/components/demos/checkbox-disabled.js";
import { CheckboxWithText } from "@/components/demos/checkbox-with-text.js";
import { CodeBlock } from "@/components/docs/code-block.js";
import {
  CodeTabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/docs/code-tabs.js";
import { ComponentPreview } from "@/components/docs/component-preview.js";
import { Steps } from "@/components/ui/steps.js";

const CheckboxPage = () => (
  <main className="mx-auto max-w-2xl px-4 py-12">
    <h1 className="mb-2 text-2xl font-semibold">Checkbox</h1>
    <p className="mb-8 text-muted-foreground">
      A control that allows the user to toggle between checked and unchecked.
    </p>

    <ComponentPreview className="mb-8">
      <CheckboxDemo />
    </ComponentPreview>

    <h2 className="mb-4 mt-10 text-xl font-semibold">Installation</h2>

    <CodeTabs defaultValue="cli">
      <TabsList>
        <TabsTrigger value="cli">CLI</TabsTrigger>
        <TabsTrigger value="manual">Manual</TabsTrigger>
      </TabsList>

      <TabsContent value="cli">
        <CodeBlock>
          {`npx shadcn@latest add "https://ui.blode.co/r/styles/default/checkbox"`}
        </CodeBlock>
      </TabsContent>

      <TabsContent value="manual">
        <Steps>
          <h3>Install the following dependencies:</h3>
          <CodeBlock className="mb-6">npm install @base-ui/react</CodeBlock>

          <h3>Copy and paste the component into your project.</h3>
          <p className="mb-3 text-sm text-muted-foreground">
            Copy{" "}
            <code className="rounded bg-secondary px-1.5 py-0.5 text-xs font-medium">
              checkbox.tsx
            </code>{" "}
            and{" "}
            <code className="rounded bg-secondary px-1.5 py-0.5 text-xs font-medium">
              checkbox.css
            </code>{" "}
            into your{" "}
            <code className="rounded bg-secondary px-1.5 py-0.5 text-xs font-medium">
              components/ui
            </code>{" "}
            directory.
          </p>

          <h3>Update the import paths to match your project setup.</h3>
        </Steps>
      </TabsContent>
    </CodeTabs>

    <h2 className="mb-4 mt-10 text-xl font-semibold">Usage</h2>

    <CodeBlock className="mb-4">
      {'import { Checkbox } from "@/components/ui/checkbox";'}
    </CodeBlock>

    <CodeBlock>{"<Checkbox />"}</CodeBlock>

    <h2 className="mb-4 mt-10 text-xl font-semibold">Examples</h2>

    <h3 className="mb-4 mt-8 text-base font-semibold">With text</h3>
    <ComponentPreview className="mb-8">
      <CheckboxWithText />
    </ComponentPreview>

    <h3 className="mb-4 mt-8 text-base font-semibold">Disabled</h3>
    <ComponentPreview>
      <CheckboxDisabled />
    </ComponentPreview>
  </main>
);

export default CheckboxPage;
