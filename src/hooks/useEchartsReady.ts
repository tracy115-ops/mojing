import { useEffect, type RefObject } from 'react';
import type ReactECharts from 'echarts-for-react';

// ECharts 5/6 under React 19 + StrictMode: first setOption frequently happens
// before the canvas has its measured size, leaving a transparent canvas.
// Force a resize on mount and whenever the option reference changes so the
// force-directed layout re-flows and the renderer paints.
export function useEchartsReady(
  ref: RefObject<ReactECharts | null>,
  trigger: unknown,
): void {
  useEffect(() => {
    const inst = ref.current?.getEchartsInstance();
    if (!inst) return;
    // Defer to next frame so container layout has settled.
    const raf = requestAnimationFrame(() => {
      inst.resize();
      // nudge animation reflow for force-directed graphs
      const opt = inst.getOption() as { series?: Array<{ type?: string }> } | undefined;
      const hasGraph = opt?.series?.some((s) => s.type === 'graph');
      if (hasGraph) {
        inst.dispatchAction({ type: 'restore' });
      }
    });
    return () => cancelAnimationFrame(raf);
  }, [ref, trigger]);
}
