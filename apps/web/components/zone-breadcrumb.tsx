/**
 * Hub trail for Blode UI zones. Composes `@blode/breadcrumb`.
 *
 * Non-Blode zones keep the dependency-free copy from
 * `blode-co/apps/web/components/zone-breadcrumb.tsx`.
 *
 * Constraints still apply:
 * 1. Absolute `https://blode.co` hrefs (preview deploys + basePath).
 * 2. Plain `<a>` via `BreadcrumbLink`, never `next/link`.
 * 3. The visible trail matches `BreadcrumbList` item for item.
 *
 * Without `trail` this is the zone root, and it shows the hub trail back to
 * blode.co: Matthew Blode -> Projects -> product. With `trail` it is a page
 * below the root, and the hub crumbs give way to a site-local trail — product
 * (now a link) -> ... -> current page. Four crumbs, two of them leaving the
 * site, is more chrome than orientation on a page that is one hop from home.
 * `breadcrumbSchema` in `lib/config.ts` splits the same way.
 */

import { Fragment } from "react";

import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";

const HOME = "https://blode.co";
const PROJECTS = `${HOME}/projects`;

interface Crumb {
  href: string;
  name: string;
}

interface Props {
  product: string;
  productHref?: string;
  trail?: Crumb[];
}

export const ZoneBreadcrumb = ({ product, productHref, trail = [] }: Props) => {
  const deeper = trail.length > 0;
  const last = trail.at(-1);

  return (
    <Breadcrumb aria-label="Breadcrumb">
      <BreadcrumbList>
        {deeper ? null : (
          <>
            <BreadcrumbItem>
              <BreadcrumbLink href={HOME} rel="author">
                Matthew Blode
              </BreadcrumbLink>
            </BreadcrumbItem>
            <BreadcrumbSeparator />
            <BreadcrumbItem>
              <BreadcrumbLink href={PROJECTS}>Projects</BreadcrumbLink>
            </BreadcrumbItem>
            <BreadcrumbSeparator />
          </>
        )}
        <BreadcrumbItem>
          {deeper && productHref ? (
            <BreadcrumbLink href={productHref}>{product}</BreadcrumbLink>
          ) : (
            <BreadcrumbPage>{product}</BreadcrumbPage>
          )}
        </BreadcrumbItem>
        {trail.map((crumb) => (
          <Fragment key={crumb.href}>
            <BreadcrumbSeparator />
            <BreadcrumbItem>
              {crumb === last ? (
                <BreadcrumbPage>{crumb.name}</BreadcrumbPage>
              ) : (
                <BreadcrumbLink href={crumb.href}>{crumb.name}</BreadcrumbLink>
              )}
            </BreadcrumbItem>
          </Fragment>
        ))}
      </BreadcrumbList>
    </Breadcrumb>
  );
};
