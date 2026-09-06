import type { ComponentProps } from "react";

import { cn } from "@/lib/utils";

/*
 * shadcn/ui Typography, as components.
 *
 * shadcn ships typography as a documented set of classes rather than a
 * registry item, so this file is that pattern written down once. The guides
 * used to style raw elements through a chain of `[&_h2]:` descendant
 * selectors on the shell; every page now says what each element is, and the
 * classes live here.
 */

export const H1 = ({ children, className, ...props }: ComponentProps<"h1">) => (
  <h1
    className={cn(
      "scroll-m-20 text-balance text-4xl font-extrabold tracking-tight lg:text-5xl",
      className
    )}
    {...props}
  >
    {children}
  </h1>
);

export const H2 = ({ children, className, ...props }: ComponentProps<"h2">) => (
  <h2
    className={cn(
      "mt-10 scroll-m-20 border-b pb-2 text-3xl font-semibold tracking-tight transition-colors first:mt-0",
      className
    )}
    {...props}
  >
    {children}
  </h2>
);

export const H3 = ({ children, className, ...props }: ComponentProps<"h3">) => (
  <h3
    className={cn(
      "mt-8 scroll-m-20 text-2xl font-semibold tracking-tight",
      className
    )}
    {...props}
  >
    {children}
  </h3>
);

export const H4 = ({ children, className, ...props }: ComponentProps<"h4">) => (
  <h4
    className={cn(
      "scroll-m-20 text-xl font-semibold tracking-tight",
      className
    )}
    {...props}
  >
    {children}
  </h4>
);

export const P = ({ className, ...props }: ComponentProps<"p">) => (
  <p
    className={cn("leading-7 [&:not(:first-child)]:mt-6", className)}
    {...props}
  />
);

export const Lead = ({ className, ...props }: ComponentProps<"p">) => (
  <p className={cn("text-muted-foreground text-xl", className)} {...props} />
);

export const Large = ({ className, ...props }: ComponentProps<"div">) => (
  <div className={cn("text-lg font-semibold", className)} {...props} />
);

export const Small = ({ className, ...props }: ComponentProps<"small">) => (
  <small
    className={cn("text-sm leading-none font-medium", className)}
    {...props}
  />
);

export const Muted = ({ className, ...props }: ComponentProps<"p">) => (
  <p className={cn("text-muted-foreground text-sm", className)} {...props} />
);

export const Blockquote = ({
  className,
  ...props
}: ComponentProps<"blockquote">) => (
  <blockquote
    className={cn("mt-6 border-l-2 pl-6 italic", className)}
    {...props}
  />
);

export const List = ({ className, ...props }: ComponentProps<"ul">) => (
  <ul className={cn("my-6 ml-6 list-disc [&>li]:mt-2", className)} {...props} />
);

export const ListItem = (props: ComponentProps<"li">) => <li {...props} />;

export const InlineCode = ({ className, ...props }: ComponentProps<"code">) => (
  <code
    className={cn(
      "bg-muted relative rounded px-[0.3rem] py-[0.2rem] font-mono text-sm font-semibold",
      className
    )}
    {...props}
  />
);

/** The wrapper owns horizontal overflow, so wide tables scroll rather than break the page. */
export const Table = ({ className, ...props }: ComponentProps<"table">) => (
  <div className="my-6 w-full overflow-y-auto">
    <table className={cn("w-full", className)} {...props} />
  </div>
);

export const Thead = (props: ComponentProps<"thead">) => <thead {...props} />;

export const Tbody = (props: ComponentProps<"tbody">) => <tbody {...props} />;

export const Tr = ({ className, ...props }: ComponentProps<"tr">) => (
  <tr className={cn("even:bg-muted m-0 border-t p-0", className)} {...props} />
);

export const Th = ({ className, ...props }: ComponentProps<"th">) => (
  <th
    className={cn(
      "border px-4 py-2 text-left font-bold [&[align=center]]:text-center [&[align=right]]:text-right",
      className
    )}
    {...props}
  />
);

export const Td = ({ className, ...props }: ComponentProps<"td">) => (
  <td
    className={cn(
      "border px-4 py-2 text-left [&[align=center]]:text-center [&[align=right]]:text-right",
      className
    )}
    {...props}
  />
);
