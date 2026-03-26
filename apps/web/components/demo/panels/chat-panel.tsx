/* eslint-disable react-perf/jsx-no-new-function-as-prop, no-warning-comments, eslint-plugin-promise/prefer-await-to-then, eslint-plugin-promise/prefer-catch, no-empty-function */
"use client";

import { usePendingCount, useQuery, useSyncClient } from "@stratasync/react";
import { SendIcon } from "blode-icons-react";
import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent } from "react";

import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";

import type { DemoTransport } from "../demo-transport";
import { NetworkToggle } from "../network-toggle";
import { SyncIndicator } from "../sync-indicator";
import type { ChatMessage } from "../types";

const SCROLL_THRESHOLD = 60;

let nextId = 0;
const uid = () => {
  nextId += 1;
  return `item-${nextId}-${Date.now()}`;
};

const getSender = (label: string) =>
  label === "Device A"
    ? { sender: "Alice", senderColor: "#3B82F6" }
    : { sender: "Bob", senderColor: "#8B5CF6" };

export const ChatPanel = ({
  label,
  transport,
}: {
  label: string;
  transport: DemoTransport;
}) => {
  const { client, state } = useSyncClient();
  const { count: pendingCount, hasPending } = usePendingCount();
  const { data: messages } = useQuery<ChatMessage>("Message", {
    orderBy: (a, b) => a.createdAt - b.createdAt,
  });

  const [inputValue, setInputValue] = useState("");
  const [isOnline, setIsOnline] = useState(true);

  const viewportRef = useRef<HTMLDivElement>(null);
  const isNearBottomRef = useRef(true);
  const isInitialLoadRef = useRef(true);

  // Track scroll position to determine if user is near bottom
  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) {
      return;
    }

    const handleScroll = () => {
      const { scrollTop, scrollHeight, clientHeight } = viewport;
      isNearBottomRef.current =
        scrollHeight - scrollTop - clientHeight < SCROLL_THRESHOLD;
    };

    viewport.addEventListener("scroll", handleScroll, { passive: true });
    return () => viewport.removeEventListener("scroll", handleScroll);
  }, []);

  // Auto-scroll on new messages (only if near bottom or initial load)
  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) {
      return;
    }

    if (isInitialLoadRef.current) {
      isInitialLoadRef.current = false;
      viewport.scrollTop = viewport.scrollHeight;
    } else if (isNearBottomRef.current) {
      viewport.scrollTo({
        behavior: "smooth",
        top: viewport.scrollHeight,
      });
    }
  }, [messages.length]);

  const sendMessage = () => {
    if (!inputValue.trim()) {
      return;
    }
    isNearBottomRef.current = true;
    const { sender, senderColor } = getSender(label);
    const now = Date.now();
    client.create("Message", {
      createdAt: now,
      id: uid(),
      sender,
      senderColor,
      text: inputValue.trim(),
    });
    setInputValue("");
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      sendMessage();
    }
  };

  const handleToggleNetwork = () => {
    const next = !isOnline;
    setIsOnline(next);
    transport.setOnline(next);
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

      {/* Message list */}
      <ScrollArea className="h-[250px]" viewportRef={viewportRef}>
        <div className="pb-2">
          {messages.map((message, index) => {
            const showSender =
              index === 0 || messages[index - 1].sender !== message.sender;

            return (
              <div
                className={cn("px-3", showSender ? "pt-2.5" : "pt-0.5")}
                key={message.id}
              >
                {showSender && (
                  <div className="mb-0.5 flex items-center gap-1.5">
                    <span
                      aria-hidden="true"
                      className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px] font-medium text-white"
                      style={{ backgroundColor: message.senderColor }}
                    >
                      {message.sender[0]}
                    </span>
                    <span
                      className="font-semibold text-xs"
                      style={{ color: message.senderColor }}
                    >
                      {message.sender}
                    </span>
                  </div>
                )}
                <p className={cn("text-sm", !showSender && "pl-[26px]")}>
                  {message.text}
                </p>
              </div>
            );
          })}
        </div>
      </ScrollArea>

      {/* Message input */}
      <div className="flex items-center gap-1 border-t p-2">
        <Input
          className="h-8 border-0 bg-transparent text-sm shadow-none focus-visible:ring-0"
          onChange={(e) => setInputValue(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Message #general..."
          value={inputValue}
        />
        <button
          aria-label="Send message"
          className="shrink-0 cursor-pointer text-muted-foreground hover:text-primary"
          onClick={sendMessage}
          type="button"
        >
          <SendIcon aria-hidden="true" className="h-3.5 w-3.5" />
        </button>
      </div>
    </section>
  );
};
