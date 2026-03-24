"use client";

import type { ComponentProps } from "react";
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
} from "react";

import { cn } from "@/lib/utils.js";

// oxlint-disable-next-line no-empty-function -- noop default for context
const noop = (_value: string) => {};

const TabsContext = createContext<{
  activeTab: string;
  setActiveTab: (value: string) => void;
}>({ activeTab: "", setActiveTab: noop });

const CodeTabs = ({
  children,
  className,
  defaultValue,
  ...props
}: ComponentProps<"div"> & { defaultValue?: string }) => {
  const [activeTab, setActiveTab] = useState(defaultValue ?? "");
  const contextValue = useMemo(
    () => ({ activeTab, setActiveTab }),
    [activeTab]
  );

  return (
    <TabsContext value={contextValue}>
      <div className={cn("my-6", className)} {...props}>
        {children}
      </div>
    </TabsContext>
  );
};

const TabsList = ({ children, className, ...props }: ComponentProps<"div">) => (
  <div
    className={cn("inline-flex gap-1 rounded-lg bg-secondary p-1", className)}
    role="tablist"
    {...props}
  >
    {children}
  </div>
);

const TabsTrigger = ({
  children,
  className,
  value,
  ...props
}: ComponentProps<"button"> & { value: string }) => {
  const { activeTab, setActiveTab } = useContext(TabsContext);
  const isActive = activeTab === value;
  const handleClick = useCallback(
    () => setActiveTab(value),
    [setActiveTab, value]
  );

  return (
    <button
      className={cn(
        "rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
        isActive
          ? "bg-background text-foreground shadow-sm"
          : "text-muted-foreground hover:text-foreground",
        className
      )}
      onClick={handleClick}
      role="tab"
      aria-selected={isActive}
      type="button"
      {...props}
    >
      {children}
    </button>
  );
};

const TabsContent = ({
  children,
  className,
  value,
  ...props
}: ComponentProps<"div"> & { value: string }) => {
  const { activeTab } = useContext(TabsContext);

  if (activeTab !== value) {
    return null;
  }

  return (
    <div className={cn("mt-4", className)} role="tabpanel" {...props}>
      {children}
    </div>
  );
};

export { CodeTabs, TabsContent, TabsList, TabsTrigger };
