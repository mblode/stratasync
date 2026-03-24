import defaultMdxComponents from "fumadocs-ui/mdx";
import type { MDXComponents } from "mdx/types";

import { Mermaid } from "./components/mermaid";
import { UseCases } from "./components/use-cases";

export const getMDXComponents = (components?: MDXComponents): MDXComponents =>
  ({
    ...defaultMdxComponents,
    Mermaid,
    UseCases,
    ...components,
  }) as MDXComponents;
