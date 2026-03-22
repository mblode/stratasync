import { source } from "@/lib/source";

export const revalidate = false;

export const GET = () => {
  const lines: string[] = [];
  // oxlint-disable-next-line no-immediate-mutation
  lines.push("# Documentation");
  lines.push("");
  for (const page of source.getPages()) {
    lines.push(`- [${page.data.title}](${page.url}): ${page.data.description}`);
  }
  return new Response(lines.join("\n"));
};
