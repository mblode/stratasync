import { RootProvider } from "fumadocs-ui/provider/next";
import localFont from "next/font/local";

import "./global.css";

const glide = localFont({
  display: "swap",
  src: [{ path: "../public/glide-variable.woff2" }],
  variable: "--font-glide",
  weight: "400 900",
});

export default function Layout({ children }: LayoutProps<"/">) {
  return (
    <html className={glide.variable} lang="en" suppressHydrationWarning>
      <body className="flex min-h-screen flex-col">
        <RootProvider>{children}</RootProvider>
      </body>
    </html>
  );
}
