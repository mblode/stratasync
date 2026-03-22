"use client";

import mermaid from "mermaid";
import { useEffect, useRef } from "react";

const renderChart = async (chart: string, container: HTMLDivElement) => {
  const dark = document.documentElement.classList.contains("dark");
  mermaid.initialize({
    fontFamily: "inherit",
    startOnLoad: false,
    theme: dark ? "dark" : "default",
  });

  const id = `mermaid-${Math.random().toString(36).slice(2, 9)}`;
  try {
    const { svg } = await mermaid.render(id, chart);
    container.innerHTML = svg;
  } catch (error) {
    console.error(error);
  }
};

// eslint-disable-next-line func-style
export function Mermaid({ chart }: { chart: string }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const render = async () => {
      if (ref.current) {
        await renderChart(chart, ref.current);
      }
    };
    // oxlint-disable-next-line prefer-await-to-then -- useEffect callback cannot be async
    render().catch(() => null);
  }, [chart]);

  useEffect(() => {
    const observer = new MutationObserver(() => {
      const rerender = async () => {
        if (ref.current) {
          await renderChart(chart, ref.current);
        }
      };
      // oxlint-disable-next-line prefer-await-to-then -- MutationObserver callback cannot be async
      rerender().catch(() => null);
    });

    observer.observe(document.documentElement, {
      attributeFilter: ["class"],
      attributes: true,
    });

    return () => observer.disconnect();
  }, [chart]);

  return <div ref={ref} className="my-4 flex justify-center overflow-x-auto" />;
}
