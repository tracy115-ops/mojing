import { useState, useCallback, useRef, useEffect } from 'react';

export interface UseResizableOptions {
  /** Minimum allowed width in px (default 320) */
  minWidth?: number;
  /** Maximum allowed width as fraction of viewport (default 0.7) */
  maxViewportFraction?: number;
  /** Initial/default width when no persisted value exists (default 460) */
  defaultWidth?: number;
  /** localStorage key for persistence */
  storageKey?: string;
}

export interface UseResizableReturn {
  /** Current panel width in px */
  width: number;
  /** Event handlers to spread onto the drag handle div */
  handleProps: {
    onPointerDown: (e: React.PointerEvent) => void;
  };
  /** Whether a drag is in progress */
  isDragging: boolean;
}

export function useResizable({
  minWidth = 320,
  maxViewportFraction = 0.7,
  defaultWidth = 460,
  storageKey = 'mojing-workbench-width',
}: UseResizableOptions = {}): UseResizableReturn {
  const [width, setWidth] = useState<number>(() => {
    try {
      const saved = localStorage.getItem(storageKey);
      if (saved) {
        const parsed = Number(saved);
        if (!isNaN(parsed) && parsed >= minWidth) return parsed;
      }
    } catch {}
    return defaultWidth;
  });

  const [isDragging, setIsDragging] = useState(false);
  const startXRef = useRef(0);
  const startWidthRef = useRef(0);

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      e.stopPropagation();

      startXRef.current = e.clientX;
      startWidthRef.current = width;
      setIsDragging(true);

      // Prevent text selection during drag
      document.body.style.userSelect = 'none';
      document.body.style.cursor = 'col-resize';

      const onPointerMove = (ev: PointerEvent) => {
        // Handle is on the left edge → dragging left = panel gets wider
        const delta = startXRef.current - ev.clientX;
        const maxWidth = Math.floor(window.innerWidth * maxViewportFraction);
        const newWidth = Math.max(minWidth, Math.min(maxWidth, startWidthRef.current + delta));
        setWidth(newWidth);
      };

      const onPointerUp = () => {
        setIsDragging(false);
        document.body.style.userSelect = '';
        document.body.style.cursor = '';

        // Persist width
        try {
          localStorage.setItem(storageKey, String(width));
        } catch {}

        document.removeEventListener('pointermove', onPointerMove);
        document.removeEventListener('pointerup', onPointerUp);
      };

      document.addEventListener('pointermove', onPointerMove);
      document.addEventListener('pointerup', onPointerUp);
    },
    [width, minWidth, maxViewportFraction, storageKey],
  );

  // Persist width when it changes and not dragging (e.g. on toggle off/on)
  useEffect(() => {
    if (!isDragging) {
      try {
        localStorage.setItem(storageKey, String(width));
      } catch {}
    }
  }, [width, isDragging, storageKey]);

  return {
    width,
    handleProps: { onPointerDown },
    isDragging,
  };
}
