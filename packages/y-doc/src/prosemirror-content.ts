// oxlint-disable no-use-before-define -- helper functions reference later-defined utilities
/**
 * ProseMirror content derivation for Yjs documents.
 *
 * Pure helpers that render a Y.Doc's ProseMirror XML fragment into derived
 * text/markdown, and seed canonical content into an empty fragment.
 */

import * as Y from "yjs";

const PROSEMIRROR_FIELD = "prosemirror";
const IMAGE_NODE_NAMES = new Set(["image", "imageblock", "taskimage"]);
const BLOCK_IMAGE_NODE_NAMES = new Set(["imageblock"]);
const EMBED_NODE_NAMES = new Set([
  "embed",
  "embedblock",
  "iframelyembed",
  "iframelyembedblock",
  "iframe",
  "iframeblock",
  "taskembed",
]);

const normalizeDerivedPart = (value: string, maxLength = 160): string => {
  const normalized = normalizeDerivedContent(value);
  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength - 3).trimEnd()}...`;
};

export const normalizeDerivedContent = (content: string): string =>
  content
    .replaceAll("\u00A0", " ")
    .replaceAll(/\n{3,}/g, "\n\n")
    .trim();

const getStringAttribute = (
  node: Y.XmlElement,
  attributeNames: readonly string[],
  maxLength: number | null = 160
): string | null => {
  for (const attributeName of attributeNames) {
    const value = node.getAttribute(attributeName);
    if (typeof value !== "string") {
      continue;
    }

    const normalized =
      maxLength === null
        ? normalizeDerivedContent(value)
        : normalizeDerivedPart(value, maxLength);
    if (normalized.length > 0) {
      return normalized;
    }
  }

  return null;
};

const uniqueDerivedParts = (parts: readonly (string | null)[]): string[] => {
  const uniqueParts: string[] = [];
  const seen = new Set<string>();

  for (const part of parts) {
    if (!part) {
      continue;
    }

    const key = part.toLowerCase();
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    uniqueParts.push(part);
  }

  return uniqueParts;
};

const formatPlaceholder = (label: string, parts: readonly string[]): string => {
  if (parts.length === 0) {
    return `[${label}]`;
  }

  return `[${label}: ${parts.join(" - ")}]`;
};

const renderBlockPlaceholder = (
  placeholder: string,
  children: string
): string => {
  const content = normalizeDerivedContent(
    [placeholder, children].filter(Boolean).join("\n")
  );

  return content.length > 0 ? `${content}\n\n` : "";
};

const renderImagePlaceholder = (
  node: Y.XmlElement,
  children: string
): string => {
  const alt = getStringAttribute(node, ["alt", "title"]) ?? "Image";
  const src = getStringAttribute(node, ["src"], null);

  if (src) {
    const nodeType = node.nodeName.toLowerCase();
    const markdown = `![${alt}](${src})`;
    if (BLOCK_IMAGE_NODE_NAMES.has(nodeType)) {
      const content = normalizeDerivedContent(
        [markdown, children].filter(Boolean).join("\n")
      );
      return content.length > 0 ? `${content}\n\n` : "";
    }
    return markdown;
  }

  const placeholder = formatPlaceholder(
    "Image",
    [alt === "Image" ? null : alt].filter(
      (part): part is string => part !== null
    )
  );

  const nodeType = node.nodeName.toLowerCase();
  if (BLOCK_IMAGE_NODE_NAMES.has(nodeType)) {
    return renderBlockPlaceholder(placeholder, children);
  }

  return placeholder;
};

const renderEmbedPlaceholder = (
  node: Y.XmlElement,
  children: string
): string => {
  const title = getStringAttribute(node, ["title", "label"]);
  const description = getStringAttribute(node, ["description", "caption"]);
  const provider = getStringAttribute(node, ["provider", "providerName"]);
  const url = getStringAttribute(
    node,
    ["url", "href", "src", "iframeSrc", "iframeUrl"],
    null
  );
  const placeholder = formatPlaceholder(
    "Embed",
    uniqueDerivedParts([title, title ? null : description, provider, url])
  );

  return renderBlockPlaceholder(placeholder, children);
};

const renderProsemirrorNodes = (nodes: readonly unknown[]): string => {
  let rendered = "";
  for (const node of nodes) {
    rendered += renderProsemirrorNode(node);
  }
  return rendered;
};

const getXmlTextContent = (node: Y.XmlText): string =>
  (node.toDelta() as { insert?: string | object }[])
    .map((op) => (typeof op.insert === "string" ? op.insert : ""))
    .join("");

// oxlint-ignore-next-line complexity -- recursive ProseMirror renderer handling many node types
// oxlint-disable-next-line complexity -- complex but clear
const renderProsemirrorNode = (node: unknown): string => {
  if (node instanceof Y.XmlText) {
    return getXmlTextContent(node);
  }

  if (!(node instanceof Y.XmlElement)) {
    return "";
  }

  const children = normalizeDerivedContent(
    renderProsemirrorNodes(node.toArray())
  );
  const nodeType = node.nodeName.toLowerCase();

  if (IMAGE_NODE_NAMES.has(nodeType)) {
    return renderImagePlaceholder(node, children);
  }

  if (EMBED_NODE_NAMES.has(nodeType)) {
    return renderEmbedPlaceholder(node, children);
  }

  switch (node.nodeName) {
    case "hardBreak": {
      return "\n";
    }
    case "heading":
    case "paragraph":
    case "blockquote":
    case "codeBlock": {
      return children.length > 0 ? `${children}\n\n` : "";
    }
    case "listItem": {
      return children.length > 0 ? `- ${children}\n` : "";
    }
    case "taskItem": {
      const checkedAttribute = node.getAttribute("checked");
      const isChecked =
        checkedAttribute === true ||
        checkedAttribute === "true" ||
        checkedAttribute === 1 ||
        checkedAttribute === "1";
      return children.length > 0
        ? `- [${isChecked ? "x" : " "}] ${children}\n`
        : "";
    }
    case "bulletList":
    case "orderedList":
    case "taskList": {
      return children.length > 0 ? `${children}\n` : "";
    }
    default: {
      return children;
    }
  }
};

export const deriveProsemirrorContent = (doc: Y.Doc): string => {
  const fragment = doc.getXmlFragment(PROSEMIRROR_FIELD);
  return normalizeDerivedContent(renderProsemirrorNodes(fragment.toArray()));
};

export const seedProsemirrorFragment = (doc: Y.Doc, content: string): void => {
  const normalized = normalizeDerivedContent(content);
  if (normalized.length === 0) {
    return;
  }

  // Only skip when the fragment already holds real text. A textless-but-present
  // fragment (e.g. an empty paragraph that y-prosemirror writes on mount, then
  // never gets the typed text because the live-editing socket dropped the
  // updates) must still be seeded from canonical content — keying off
  // fragment.length here would leave the editor permanently empty.
  if (deriveProsemirrorContent(doc).length > 0) {
    return;
  }

  const fragment = doc.getXmlFragment(PROSEMIRROR_FIELD);
  // Drop any textless children first so we don't leave a leading blank line.
  if (fragment.length > 0) {
    fragment.delete(0, fragment.length);
  }

  const paragraph = new Y.XmlElement("paragraph");
  const textNode = new Y.XmlText();
  textNode.insert(0, normalized);
  paragraph.insert(0, [textNode]);
  fragment.insert(fragment.length, [paragraph]);
};
