import {
  Chart,
  TimeScale,
  LinearScale,
  PointElement,
  LineElement,
  BarElement,
  BarController,
  Tooltip,
  Legend,
  Filler,
} from 'chart.js';
import zoomPlugin from 'chartjs-plugin-zoom';

let registered = false;

export function registerChart(): void {
  if (registered) return;
  Chart.register(
    TimeScale,
    LinearScale,
    PointElement,
    LineElement,
    BarElement,
    BarController,
    Tooltip,
    Legend,
    Filler,
    zoomPlugin,
  );
  registered = true;
}
