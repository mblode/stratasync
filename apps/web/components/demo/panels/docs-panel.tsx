/* eslint-disable react-perf/jsx-no-new-function-as-prop, no-warning-comments, eslint-plugin-promise/prefer-await-to-then, eslint-plugin-promise/prefer-catch, no-empty-function, sort-keys, eslint-plugin-import/no-named-as-default */
"use client";

import { usePendingCount, useSyncClient } from "@stratasync/react";
import Collaboration from "@tiptap/extension-collaboration";
import Placeholder from "@tiptap/extension-placeholder";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { useState } from "react";

import { ScrollArea } from "@/components/ui/scroll-area";

import type { DemoTransport } from "../demo-transport";
import { NetworkToggle } from "../network-toggle";
import { SyncIndicator } from "../sync-indicator";
import { useDemoYjsRelay } from "../use-demo-yjs";

// ---------------------------------------------------------------------------
// Initial document content (ProseMirror JSON)
// ---------------------------------------------------------------------------

const INITIAL_CONTENT = {
  content: [
    {
      attrs: { level: 2 },
      content: [{ type: "text", text: "Project Brief" }],
      type: "heading",
    },
    {
      content: [
        {
          type: "text",
          text: "This document outlines the key goals and milestones for Q1.",
        },
      ],
      type: "paragraph",
    },
    {
      attrs: { level: 2 },
      content: [{ type: "text", text: "Goals" }],
      type: "heading",
    },
    {
      content: [
        {
          type: "listItem",
          content: [
            {
              type: "paragraph",
              content: [{ type: "text", text: "Launch beta by March" }],
            },
          ],
        },
        {
          type: "listItem",
          content: [
            {
              type: "paragraph",
              content: [{ type: "text", text: "Onboard 50 users" }],
            },
          ],
        },
      ],
      type: "bulletList",
    },
  ],
  type: "doc",
};

// ---------------------------------------------------------------------------
// DocsPanel
// ---------------------------------------------------------------------------

export const DocsPanel = ({
  label,
  transport,
}: {
  label: string;
  transport: DemoTransport;
}) => {
  const { state } = useSyncClient();
  const { count: pendingCount, hasPending } = usePendingCount();
  const relay = useDemoYjsRelay(label);

  const [isOnline, setIsOnline] = useState(true);

  const editor = useEditor(
    {
      editorProps: {
        attributes: {
          class: "outline-none h-full",
        },
      },
      extensions: [
        StarterKit.configure({
          heading: { levels: [2] },
          undoRedo: false,
        }),
        ...(relay
          ? [
              Collaboration.configure({
                document: relay.doc,
                field: "prosemirror",
              }),
            ]
          : []),
        Placeholder.configure({
          placeholder: "Start writing...",
        }),
      ],
      immediatelyRender: false,
      onCreate: ({ editor: e }) => {
        if (label === "Device A" && e.isEmpty) {
          e.commands.setContent(INITIAL_CONTENT);
        }
      },
    },
    [relay?.doc]
  );

  const handleToggleNetwork = () => {
    const next = !isOnline;
    setIsOnline(next);
    transport.setOnline(next);
    relay?.setOnline(next);
  };

  return (
    <section
      aria-label={label}
      className="flex flex-col overflow-hidden rounded-2xl border border-border bg-card"
    >
      {/* Header */}
      <div className="flex items-center gap-2 border-b px-3 py-2">
        <div className="flex items-center gap-2">
          <span className="font-medium text-xs">{label}</span>
          <SyncIndicator isOnline={isOnline} status={state} />
        </div>
        <div className="ml-auto flex items-center gap-1">
          {hasPending && (
            <span
              aria-label={`${pendingCount} change${pendingCount === 1 ? "" : "s"} pending`}
              className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-amber-100 px-1.5 font-medium text-amber-700 text-xs dark:bg-amber-900/30 dark:text-amber-400"
            >
              {pendingCount}
            </span>
          )}
          <NetworkToggle isOnline={isOnline} onToggle={handleToggleNetwork} />
        </div>
      </div>

      {/* Editor */}
      <ScrollArea className="h-[250px]">
        <EditorContent
          className="px-3 py-2 text-sm [&_.tiptap]:outline-none [&_.tiptap_h2]:mb-0.5 [&_.tiptap_h2]:mt-3 [&_.tiptap_h2]:font-semibold [&_.tiptap_h2]:text-base first:[&_.tiptap_>_h2]:mt-0 [&_.tiptap_li]:text-foreground/80 [&_.tiptap_li]:text-sm [&_.tiptap_li_p]:mb-0 [&_.tiptap_p.is-editor-empty:first-child::before]:pointer-events-none [&_.tiptap_p.is-editor-empty:first-child::before]:float-left [&_.tiptap_p.is-editor-empty:first-child::before]:h-0 [&_.tiptap_p.is-editor-empty:first-child::before]:text-muted-foreground/50 [&_.tiptap_p.is-editor-empty:first-child::before]:content-[attr(data-placeholder)] [&_.tiptap_p]:mb-0.5 [&_.tiptap_p]:text-foreground/80 [&_.tiptap_p]:text-sm [&_.tiptap_ul]:my-0.5 [&_.tiptap_ul]:list-disc [&_.tiptap_ul]:pl-5"
          editor={editor}
        />
      </ScrollArea>
    </section>
  );
};
