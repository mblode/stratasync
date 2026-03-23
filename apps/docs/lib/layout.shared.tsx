import type { BaseLayoutProps } from "fumadocs-ui/layouts/shared";

export const baseOptions = (): BaseLayoutProps => ({
  githubUrl: "https://github.com/stratasync/stratasync",
  links: [
    {
      text: "Website",
      url: "https://stratasync.dev",
    },
  ],
  nav: {
    title: "Strata Sync",
  },
});
