import defaultMdxComponents from "fumadocs-ui/mdx";
import type { MDXComponents } from "mdx/types";
import type { ComponentPropsWithoutRef } from "react";
import { isValidElement } from "react";

import { Mermaid } from "./components/mermaid";

const extractTextContent = (node: React.ReactNode): string => {
  if (typeof node === "string") {
    return node;
  }
  if (typeof node === "number") {
    return String(node);
  }
  if (!isValidElement(node)) {
    return "";
  }
  const { children } = node.props as { children?: React.ReactNode };
  if (!children) {
    return "";
  }
  if (Array.isArray(children)) {
    return (children as React.ReactNode[]).map(extractTextContent).join("");
  }
  return extractTextContent(children);
};

const Pre = (props: ComponentPropsWithoutRef<"pre">) => {
  const { children } = props;

  if (isValidElement(children)) {
    const childProps = children.props as {
      className?: string;
      children?: React.ReactNode;
    };
    if (childProps.className?.includes("language-mermaid")) {
      const chart = extractTextContent(children);
      return <Mermaid chart={chart} />;
    }
  }

  const DefaultPre = defaultMdxComponents.pre as React.ComponentType<
    ComponentPropsWithoutRef<"pre">
  >;
  return DefaultPre ? <DefaultPre {...props} /> : <pre {...props} />;
};

export const getMDXComponents = (components?: MDXComponents): MDXComponents =>
  ({
    ...defaultMdxComponents,
    pre: Pre,
    ...components,
  }) as MDXComponents;
