import type { MetadataRoute } from "next";

const siteUrl = "https://stratasync.dev";
const staticRoutes = ["", "docs"];
const TRAILING_SLASH_REGEX = /\/$/;

const getChangeFrequency = (route: string) =>
  route === "" || route === "docs" ? "weekly" : "monthly";

const getPriority = (route: string) => {
  if (route === "") {
    return 1;
  }
  if (route === "docs") {
    return 0.8;
  }
  return 0.6;
};

export default function sitemap(): MetadataRoute.Sitemap {
  const lastModified = new Date();

  return staticRoutes.map((route) => ({
    url: `${siteUrl}/${route}`.replace(TRAILING_SLASH_REGEX, ""),
    lastModified,
    changeFrequency: getChangeFrequency(route),
    priority: getPriority(route),
  }));
}
