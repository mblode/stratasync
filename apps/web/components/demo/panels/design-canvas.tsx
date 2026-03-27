/* eslint-disable react-perf/jsx-no-new-function-as-prop, eslint-plugin-jsx-a11y/click-events-have-key-events, eslint-plugin-jsx-a11y/no-static-element-interactions, eslint-plugin-jsx-a11y/role-has-required-aria-props, eslint-plugin-unicorn/no-immediate-mutation */
"use client";

import { useCallback, useRef, useState } from "react";

import { cn } from "@/lib/utils";

import type { Layer } from "../types";

const MIN_SIZE = 20;
const THROTTLE_MS = 500;

type Corner = "ne" | "nw" | "se" | "sw";

const CORNER_CURSORS: Record<Corner, string> = {
  ne: "cursor-nesw-resize",
  nw: "cursor-nwse-resize",
  se: "cursor-nwse-resize",
  sw: "cursor-nesw-resize",
};

const CORNER_POSITIONS: Record<Corner, string> = {
  ne: "-top-1 -right-1",
  nw: "-top-1 -left-1",
  se: "-bottom-1 -right-1",
  sw: "-bottom-1 -left-1",
};

const computeResizeBounds = (
  corner: Corner,
  startBounds: { h: number; w: number; x: number; y: number },
  dx: number,
  dy: number
) => {
  let { x, y, w, h } = startBounds;

  if (corner.includes("e")) {
    w = Math.max(MIN_SIZE, startBounds.w + dx);
  }
  if (corner.includes("w")) {
    w = Math.max(MIN_SIZE, startBounds.w - dx);
    x = startBounds.x + (startBounds.w - w);
  }
  if (corner.includes("s")) {
    h = Math.max(MIN_SIZE, startBounds.h + dy);
  }
  if (corner.includes("n")) {
    h = Math.max(MIN_SIZE, startBounds.h - dy);
    y = startBounds.y + (startBounds.h - h);
  }

  return { height: h, width: w, x, y };
};

const ShapeContent = ({ layer }: { layer: Layer }) => {
  switch (layer.type) {
    case "rectangle": {
      return (
        <div
          className="h-full w-full rounded-sm"
          style={{ backgroundColor: layer.color }}
        />
      );
    }
    case "ellipse": {
      return (
        <div
          className="h-full w-full rounded-full"
          style={{ backgroundColor: layer.color }}
        />
      );
    }
    case "text": {
      return (
        <div
          className="flex h-full w-full items-center overflow-hidden px-1"
          style={{ color: layer.color }}
        >
          <span
            className="truncate font-medium leading-none"
            style={{ fontSize: `${Math.max(8, layer.height * 0.4)}px` }}
          >
            {layer.name}
          </span>
        </div>
      );
    }
    case "frame": {
      return (
        <div
          className="h-full w-full rounded-sm border-[1.5px] border-dashed"
          style={{
            backgroundColor: `${layer.color}1a`,
            borderColor: layer.color,
          }}
        />
      );
    }
    default: {
      return null;
    }
  }
};

const SelectionOverlay = ({
  layer,
  onResize,
  onLocalOverride,
  onLocalOverrideClear,
}: {
  layer: Layer;
  onResize: (layerId: string, changes: Partial<Layer>) => void;
  onLocalOverride: (id: string, changes: Partial<Layer>) => void;
  onLocalOverrideClear: (id: string) => void;
}) => {
  const lastSyncRef = useRef(0);

  const handleResizeStart = useCallback(
    (corner: Corner, e: React.PointerEvent) => {
      e.stopPropagation();
      e.preventDefault();

      const target = e.currentTarget as HTMLElement;
      target.setPointerCapture(e.pointerId);

      const startX = e.clientX;
      const startY = e.clientY;
      const pointerId = e.pointerId;
      const startBounds = {
        h: layer.height,
        w: layer.width,
        x: layer.x,
        y: layer.y,
      };

      const handlePointerMove = (ev: PointerEvent) => {
        const dx = ev.clientX - startX;
        const dy = ev.clientY - startY;
        const bounds = computeResizeBounds(corner, startBounds, dx, dy);

        // Local: every frame for smooth rendering
        onLocalOverride(layer.id, bounds);

        // Sync: throttled for other device
        const now = performance.now();
        if (now - lastSyncRef.current >= THROTTLE_MS) {
          lastSyncRef.current = now;
          onResize(layer.id, { ...bounds, updatedAt: Date.now() });
        }
      };

      const handlePointerUp = (ev: PointerEvent) => {
        const dx = ev.clientX - startX;
        const dy = ev.clientY - startY;
        const bounds = computeResizeBounds(corner, startBounds, dx, dy);

        // Final commit + clear local override
        onResize(layer.id, { ...bounds, updatedAt: Date.now() });
        onLocalOverrideClear(layer.id);

        target.releasePointerCapture(pointerId);
        target.removeEventListener("pointermove", handlePointerMove);
        target.removeEventListener("pointerup", handlePointerUp);
      };

      target.addEventListener("pointermove", handlePointerMove);
      target.addEventListener("pointerup", handlePointerUp);
    },
    [
      layer.id,
      layer.x,
      layer.y,
      layer.width,
      layer.height,
      onResize,
      onLocalOverride,
      onLocalOverrideClear,
    ]
  );

  return (
    <div
      className="pointer-events-none absolute ring-[1.5px] ring-primary"
      style={{
        height: layer.height,
        left: layer.x,
        top: layer.y,
        width: layer.width,
      }}
    >
      {(Object.keys(CORNER_POSITIONS) as Corner[]).map((corner) => (
        <div
          key={corner}
          aria-label={`Resize ${corner}`}
          className={cn(
            "pointer-events-auto absolute h-2 w-2 rounded-[1px] border-[1.5px] border-primary bg-white",
            CORNER_CURSORS[corner],
            CORNER_POSITIONS[corner]
          )}
          onPointerDown={(e) => handleResizeStart(corner, e)}
          role="slider"
          tabIndex={-1}
        />
      ))}
    </div>
  );
};

export const DesignCanvas = ({
  layers,
  selectedId,
  onSelect,
  onUpdateLayer,
}: {
  layers: Layer[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onUpdateLayer: (id: string, changes: Partial<Layer>) => void;
}) => {
  const canvasRef = useRef<HTMLDivElement>(null);
  const lastSyncRef = useRef(0);
  const [isDragging, setIsDragging] = useState(false);
  const [localOverrides, setLocalOverrides] = useState<
    Map<string, Partial<Layer>>
  >(new Map());

  // Merge local overrides on top of synced layer data
  const resolvedLayers = layers.map((l) => {
    const override = localOverrides.get(l.id);
    return override ? { ...l, ...override } : l;
  });

  const visibleLayers = resolvedLayers.filter((l) => l.visible);
  const selectedLayer = selectedId
    ? resolvedLayers.find((l) => l.id === selectedId)
    : null;

  const handleLocalOverride = useCallback(
    (id: string, changes: Partial<Layer>) => {
      setLocalOverrides((prev) => {
        const next = new Map(prev);
        next.set(id, { ...prev.get(id), ...changes });
        return next;
      });
    },
    []
  );

  const handleLocalOverrideClear = useCallback((id: string) => {
    setLocalOverrides((prev) => {
      const next = new Map(prev);
      next.delete(id);
      return next;
    });
  }, []);

  const handleCanvasClick = useCallback(
    (e: React.MouseEvent) => {
      if (e.target === e.currentTarget) {
        onSelect(null);
      }
    },
    [onSelect]
  );

  const handleDragStart = useCallback(
    (layer: Layer, e: React.PointerEvent) => {
      e.stopPropagation();
      e.preventDefault();
      onSelect(layer.id);
      setIsDragging(true);

      const target = e.currentTarget as HTMLElement;
      target.setPointerCapture(e.pointerId);

      const startX = e.clientX;
      const startY = e.clientY;
      const pointerId = e.pointerId;
      const startLayerX = layer.x;
      const startLayerY = layer.y;

      const computePosition = (clientX: number, clientY: number) => {
        const dx = clientX - startX;
        const dy = clientY - startY;

        const canvas = canvasRef.current;
        const maxX = canvas
          ? canvas.clientWidth - layer.width
          : Number.POSITIVE_INFINITY;
        const maxY = canvas
          ? canvas.clientHeight - layer.height
          : Number.POSITIVE_INFINITY;

        return {
          x: Math.max(0, Math.min(maxX, startLayerX + dx)),
          y: Math.max(0, Math.min(maxY, startLayerY + dy)),
        };
      };

      const handlePointerMove = (ev: PointerEvent) => {
        const pos = computePosition(ev.clientX, ev.clientY);

        // Local: every frame for smooth rendering
        handleLocalOverride(layer.id, pos);

        // Sync: throttled for other device
        const now = performance.now();
        if (now - lastSyncRef.current >= THROTTLE_MS) {
          lastSyncRef.current = now;
          onUpdateLayer(layer.id, { ...pos, updatedAt: Date.now() });
        }
      };

      const handlePointerUp = (ev: PointerEvent) => {
        setIsDragging(false);

        const pos = computePosition(ev.clientX, ev.clientY);

        // Final commit + clear local override
        onUpdateLayer(layer.id, { ...pos, updatedAt: Date.now() });
        handleLocalOverrideClear(layer.id);

        target.releasePointerCapture(pointerId);
        target.removeEventListener("pointermove", handlePointerMove);
        target.removeEventListener("pointerup", handlePointerUp);
      };

      target.addEventListener("pointermove", handlePointerMove);
      target.addEventListener("pointerup", handlePointerUp);
    },
    [onSelect, onUpdateLayer, handleLocalOverride, handleLocalOverrideClear]
  );

  return (
    <div
      ref={canvasRef}
      className={cn(
        "relative h-[250px] touch-none overflow-hidden",
        isDragging && "select-none"
      )}
      onClick={handleCanvasClick}
      style={{
        backgroundImage:
          "radial-gradient(circle, var(--color-border) 0.5px, transparent 0.5px)",
        backgroundSize: "12px 12px",
      }}
    >
      {visibleLayers.map((layer) => (
        <div
          key={layer.id}
          className={cn(
            "absolute cursor-move",
            selectedId === layer.id && "z-10"
          )}
          onPointerDown={(e) => handleDragStart(layer, e)}
          style={{
            height: layer.height,
            left: layer.x,
            top: layer.y,
            width: layer.width,
          }}
        >
          <ShapeContent layer={layer} />
        </div>
      ))}

      {selectedLayer?.visible && (
        <SelectionOverlay
          layer={selectedLayer}
          onLocalOverride={handleLocalOverride}
          onLocalOverrideClear={handleLocalOverrideClear}
          onResize={onUpdateLayer}
        />
      )}
    </div>
  );
};
