import type { Code, Root } from "mdast";
import type { MdxJsxFlowElement } from "mdast-util-mdx-jsx";
import type { Plugin } from "unified";
import { visit } from "unist-util-visit";

const remarkMermaid: Plugin<[], Root> = () => (tree: Root) => {
  visit(tree, "code", (node: Code, index, parent) => {
    if (node.lang !== "mermaid" || index === undefined || !parent) {
      return;
    }

    const jsxNode: MdxJsxFlowElement = {
      attributes: [
        {
          name: "chart",
          type: "mdxJsxAttribute",
          value: node.value,
        },
      ],
      children: [],
      name: "Mermaid",
      type: "mdxJsxFlowElement",
    };

    parent.children.splice(
      index,
      1,
      jsxNode as unknown as (typeof parent.children)[number]
    );
  });
};

export default remarkMermaid;
