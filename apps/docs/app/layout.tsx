import { RootProvider } from "fumadocs-ui/provider/next";
import type { Metadata } from "next";

import "./global.css";

export const metadata: Metadata = {
  appleWebApp: {
    title: "Strata Sync",
  },
};

export default function Layout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="flex min-h-screen flex-col">
        <RootProvider>{children}</RootProvider>
      </body>
    </html>
  );
}
