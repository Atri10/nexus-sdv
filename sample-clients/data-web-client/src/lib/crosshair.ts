import { type ChartType, type Plugin } from 'chart.js';

export interface HudCrosshairOptions {
  color: string;
}

declare module 'chart.js' {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  interface PluginOptionsByType<TType extends ChartType> {
    hudCrosshair: HudCrosshairOptions;
  }
}

/**
 * HUD crosshair: a dashed vertical line at the hovered x spanning the chart
 * area, plus a faint dashed horizontal at the hovered y. Drawn on top of the
 * datasets after every render; when no element is active nothing is drawn,
 * so the crosshair clears itself on the next frame.
 */
export const hudCrosshair: Plugin<'line', HudCrosshairOptions> = {
  id: 'hudCrosshair',
  afterDatasetsDraw(chart) {
    const { ctx, chartArea } = chart;
    const options = chart.options.plugins?.hudCrosshair;
    const active = chart.getActiveElements();
    if (!options?.color || !chartArea || active.length === 0) return;

    const el = active[0].element as { x?: number; y?: number };
    if (typeof el.x !== 'number' || typeof el.y !== 'number') return;

    ctx.save();
    ctx.strokeStyle = options.color;
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(el.x, chartArea.top);
    ctx.lineTo(el.x, chartArea.bottom);
    ctx.stroke();
    // Faint horizontal at the hovered y.
    ctx.globalAlpha = 0.4;
    ctx.beginPath();
    ctx.moveTo(chartArea.left, el.y);
    ctx.lineTo(chartArea.right, el.y);
    ctx.stroke();
    ctx.restore();
  },
};
