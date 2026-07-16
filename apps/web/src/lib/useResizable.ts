/**
 * Drag-to-resize column width (red: UI 不要写死，可自由调整)
 */

import { useCallback, useEffect, useState, type MouseEvent as ReactMouseEvent } from "react";

export function useResizableWidth(
  key: string,
  defaults: { initial: number; min: number; max: number }
) {
  const [width, setWidth] = useState(() => {
    try {
      const raw = localStorage.getItem(`paw-col-w:${key}`);
      if (raw) {
        const n = Number(raw);
        if (Number.isFinite(n)) return Math.min(defaults.max, Math.max(defaults.min, n));
      }
    } catch {
      /* ignore */
    }
    return defaults.initial;
  });

  useEffect(() => {
    try {
      localStorage.setItem(`paw-col-w:${key}`, String(width));
    } catch {
      /* ignore */
    }
  }, [key, width]);

  /** edge: "right" = drag right edge expands; "left" = drag left edge expands (detail panels) */
  const onResizeStart = useCallback(
    (edge: "left" | "right") => (e: ReactMouseEvent) => {
      e.preventDefault();
      const startX = e.clientX;
      const startW = width;
      const onMove = (ev: MouseEvent) => {
        const delta = edge === "right" ? ev.clientX - startX : startX - ev.clientX;
        setWidth(Math.min(defaults.max, Math.max(defaults.min, startW + delta)));
      };
      const onUp = () => {
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    },
    [width, defaults.max, defaults.min]
  );

  return { width, setWidth, onResizeStart };
}
