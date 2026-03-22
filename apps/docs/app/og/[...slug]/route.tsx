import { generate as DefaultImage } from "fumadocs-ui/og";
import { notFound } from "next/navigation";
import { ImageResponse } from "next/og";

import { getPageImage, source } from "@/lib/source";

export const revalidate = false;

export const GET = async (
  _req: Request,
  { params }: RouteContext<"/og/[...slug]">
) => {
  const { slug } = await params;
  const page = source.getPage(slug.slice(0, -1));
  if (!page) {
    notFound();
  }

  return new ImageResponse(
    <DefaultImage
      description={page.data.description}
      site="My App"
      title={page.data.title}
    />,
    {
      height: 630,
      width: 1200,
    }
  );
};

export const generateStaticParams = () =>
  source.getPages().map((page) => ({
    lang: page.locale,
    slug: getPageImage(page).segments,
  }));
