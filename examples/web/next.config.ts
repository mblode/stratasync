import type { NextConfig } from "next";

const config: NextConfig = {
  experimental: {
    externalDir: true,
  },
  reactStrictMode: true,
  transpilePackages: [
    "@stratasync/client",
    "@stratasync/core",
    "@stratasync/mobx",
    "@stratasync/next",
    "@stratasync/react",
    "@stratasync/storage-idb",
    "@stratasync/transport-graphql",
    "@stratasync/yjs",
  ],
};

export default config;
