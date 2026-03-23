import defaultMdxComponents from "fumadocs-ui/mdx";
import type { MDXComponents } from "mdx/types";

import { Mermaid } from "./components/mermaid";

export const getMDXComponents = (components?: MDXComponents): MDXComponents =>
  ({
    ...defaultMdxComponents,
    Mermaid,
    ...components,
  }) as MDXComponents;
