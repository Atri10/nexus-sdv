import {
  Chart,
  Decimation,
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
import 'chartjs-adapter-date-fns';
import { hudCrosshair } from '@/lib/crosshair';

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
    Decimation,
    zoomPlugin,
    hudCrosshair,
  );
  registered = true;
}
