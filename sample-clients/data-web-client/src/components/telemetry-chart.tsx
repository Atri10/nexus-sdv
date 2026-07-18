'use client';

import { useEffect, useRef, useState } from 'react';
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Title,
  Tooltip,
  Legend,
  Filler,
  TimeScale,
} from 'chart.js';
import { Chart } from 'react-chartjs-2';
import 'chartjs-adapter-date-fns';

ChartJS.register(
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Title,
  Tooltip,
  Legend,
  Filler,
  TimeScale
);

interface TelemetryPoint {
  timestamp: string;
  values: Record<string, string>;
}

interface TelemetryChartProps {
  vehicleId: string;
  columns: string[];
}

export default function TelemetryChart({ vehicleId, columns }: TelemetryChartProps) {
  const [data, setData] = useState<TelemetryPoint[]>([]);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const datasetsRef = useRef<Map<string, { label: string; data: { x: Date; y: number }[] }>>(new Map());

  // Maximum data points to keep in chart (to prevent memory issues)
  const MAX_POINTS = 300;

  // Initial fetch of historical data
  useEffect(() => {
    fetchHistoricalData();
  }, [vehicleId, columns]);

  // WebSocket connection for live updates
  useEffect(() => {
    connectWebSocket();

    return () => {
      if (wsRef.current) {
        wsRef.current.close();
      }
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
      }
    };
  }, [vehicleId, columns]);

  const fetchHistoricalData = async () => {
    try {
      const params = new URLSearchParams();
      params.set('start', new Date(Date.now() - 3600 * 1000).toISOString()); // Last hour
      params.set('end', new Date().toISOString());
      params.set('columns', columns.join(','));
      params.set('limit', '200');

      const response = await fetch(`/api/telemetry/${vehicleId}?${params.toString()}`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const points: TelemetryPoint[] = await response.json();
      setData(points);

      // Initialize datasets
      const newDatasets = new Map<string, { label: string; data: { x: Date; y: number }[] }>();
      columns.forEach(col => {
        newDatasets.set(col, {
          label: col.replace(/^dynamic:/, '').replace(/^static:/, ''),
          data: points
            .filter(p => p.values[col] !== undefined)
            .map(p => ({
              x: new Date(p.timestamp),
              y: parseFloat(p.values[col])
            }))
        });
      });
      datasetsRef.current = newDatasets;
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to fetch historical data');
    }
  };

  const connectWebSocket = () => {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/api/v1/vehicles/${vehicleId}/telemetry/live`;

    wsRef.current = new WebSocket(wsUrl);

    wsRef.current.onopen = () => {
      console.log('WebSocket connected');
      setConnected(true);
      setError(null);

      // Subscribe to columns
      wsRef.current?.send(JSON.stringify({
        type: 'subscribe',
        vehicleId,
        columns
      }));
    };

    wsRef.current.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data);

        if (message.type === 'telemetry') {
          const newPoints = message.data as TelemetryPoint[];
          updateChartWithNewData(newPoints);
        } else if (message.type === 'subscribed') {
          console.log('Subscribed to:', message.vehicleId, message.columns);
        } else if (message.type === 'error') {
          setError(message.message);
        }
      } catch (e) {
        console.error('Error parsing WebSocket message:', e);
      }
    };

    wsRef.current.onclose = () => {
      console.log('WebSocket disconnected');
      setConnected(false);

      // Reconnect after 5 seconds
      reconnectTimeoutRef.current = setTimeout(() => {
        connectWebSocket();
      }, 5000);
    };

    wsRef.current.onerror = (err) => {
      console.error('WebSocket error:', err);
      setError('WebSocket connection error');
    };
  };

  const updateChartWithNewData = (newPoints: TelemetryPoint[]) => {
    setData(prev => {
      const combined = [...prev, ...newPoints];
      // Keep only last MAX_POINTS
      return combined.slice(-MAX_POINTS);
    });

    // Update datasets
    newPoints.forEach(point => {
      columns.forEach(col => {
        const value = point.values[col];
        if (value !== undefined) {
          const y = parseFloat(value);
          if (!isNaN(y)) {
            const dataset = datasetsRef.current.get(col);
            if (dataset) {
              dataset.data.push({ x: new Date(point.timestamp), y });
              // Trim old data
              if (dataset.data.length > MAX_POINTS) {
                dataset.data = dataset.data.slice(-MAX_POINTS);
              }
            }
          }
        }
      });
    });

    // Force chart update
    datasetsRef.current = new Map(datasetsRef.current);
  };

  // Build chart datasets
  const chartData = {
    datasets: Array.from(datasetsRef.current.values()).map((dataset, index) => ({
      label: dataset.label,
      data: dataset.data,
      borderColor: COLORS[index % COLORS.length],
      backgroundColor: COLORS[index % COLORS.length] + '20', // 20% opacity
      borderWidth: 2,
      pointRadius: 0,
      pointHoverRadius: 4,
      tension: 0.2,
      fill: false,
    }))
  };

  const options = {
    responsive: true,
    maintainAspectRatio: false,
    interaction: {
      mode: 'index' as const,
      intersect: false,
    },
    plugins: {
      legend: {
        display: true,
        position: 'top' as const,
      },
      tooltip: {
        mode: 'index' as const,
        intersect: false,
      },
    },
    scales: {
      x: {
        type: 'time' as const,
        time: {
          unit: 'second' as const,
          displayFormats: {
            second: 'HH:mm:ss',
            minute: 'HH:mm',
            hour: 'HH:mm',
          },
        },
        title: {
          display: true,
          text: 'Time',
        },
      },
      y: {
        title: {
          display: true,
          text: 'Value',
        },
        beginAtZero: false,
      },
    },
    animation: {
      duration: 0, // Disable animations for real-time updates
    },
  };

  return (
    <div className="rounded border border-gray-200 bg-white p-4">
      <div className="flex items-center justify-between mb-2">
        <h2 className="text-lg font-medium text-gray-900">Live Telemetry</h2>
        <div className="flex items-center gap-3 text-sm">
          <span
            className={`flex items-center gap-1 ${connected ? 'text-green-600' : 'text-red-600'}`}
          >
            <span
              className={`w-2 h-2 rounded-full ${connected ? 'bg-green-500' : 'bg-red-500'}`}
            />
            {connected ? 'Live' : 'Connecting...'}
          </span>
          {error && <span className="text-red-500">{error}</span>}
        </div>
      </div>
      <div style={{ height: '300px' }}>
        <Chart type="line" data={chartData} options={options} />
      </div>
      <p className="text-xs text-gray-500 mt-2">
        Showing: {Array.from(datasetsRef.current.keys()).map(c => c.replace(/^(dynamic|static):/, '')).join(', ')}
      </p>
    </div>
  );
}

const COLORS = [
  '#3b82f6', // blue
  '#ef4444', // red
  '#22c55e', // green
  '#f59e0b', // amber
  '#8b5cf6', // violet
  '#ec4899', // pink
  '#06b6d4', // cyan
  '#f97316', // orange
];
