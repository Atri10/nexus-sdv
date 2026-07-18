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
  ChartOptions,
} from 'chart.js';
import { Line } from 'react-chartjs-2';

ChartJS.register(
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Title,
  Tooltip,
  Legend,
  Filler
);

interface TelemetryChartProps {
  vehicleId: string;
  columns: string[];
  wsUrl?: string;
}

interface TelemetryPoint {
  timestamp: string;
  values: Record<string, string>;
}

interface WebSocketMessage {
  type: string;
  vehicleId?: string;
  timestamp?: string;
  values?: Record<string, string>;
  columns?: string[];
  message?: string;
}

export default function TelemetryChart({ vehicleId, columns, wsUrl }: TelemetryChartProps) {
  const [dataPoints, setDataPoints] = useState<TelemetryPoint[]>([]);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const maxPoints = 100; // Keep last 100 points

  // Initialize chart data structure
  const chartData = {
    labels: dataPoints.map((p) => new Date(p.timestamp).toLocaleTimeString()),
    datasets: columns.map((col, index) => ({
      label: col.replace('dynamic:', '').replace('static:', ''),
      data: dataPoints.map((p) => parseFloat(p.values[col] ?? 'NaN')),
      borderColor: COLORS[index % COLORS.length],
      backgroundColor: COLORS[index % COLORS.length] + '33', // 20% opacity
      fill: false,
      tension: 0.2,
      pointRadius: 2,
      pointHoverRadius: 5,
    })),
  };

  const chartOptions: ChartOptions<'line'> = {
    responsive: true,
    maintainAspectRatio: false,
    animation: {
      duration: 200,
    },
    interaction: {
      mode: 'index',
      intersect: false,
    },
    scales: {
      x: {
        display: true,
        title: {
          display: true,
          text: 'Time',
        },
      },
      y: {
        display: true,
        title: {
          display: true,
          text: 'Value',
        },
        type: 'linear',
        // Allow dynamic scaling
      },
    },
    plugins: {
      legend: {
        display: true,
        position: 'top',
      },
      title: {
        display: true,
        text: `Live Telemetry: ${vehicleId}`,
      },
    },
  };

  // Connect to WebSocket
  useEffect(() => {
    const url = wsUrl || `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}/api/v1/vehicles/${vehicleId}/telemetry/live`;
    
    const ws = new WebSocket(url);
    wsRef.current = ws;

    ws.onopen = () => {
      console.log('WebSocket connected');
      setConnected(true);
      setError(null);
      
      // Subscribe to columns
      ws.send(JSON.stringify({
        type: 'subscribe',
        vehicleId,
        columns,
      }));
    };

    ws.onmessage = (event) => {
      try {
        const msg: WebSocketMessage = JSON.parse(event.data);
        
        switch (msg.type) {
          case 'telemetry':
            if (msg.timestamp && msg.values) {
              setDataPoints((prev) => {
                const newPoints = [...prev, { timestamp: msg.timestamp!, values: msg.values! }];
                if (newPoints.length > maxPoints) {
                  return newPoints.slice(-maxPoints);
                }
                return newPoints;
              });
            }
            break;
          case 'subscribed':
            console.log('Subscribed to:', msg.vehicleId, msg.columns);
            break;
          case 'error':
            setError(msg.message || 'WebSocket error');
            break;
          case 'pong':
            // Heartbeat response
            break;
        }
      } catch (e) {
        console.error('Failed to parse WebSocket message:', e);
      }
    };

    ws.onerror = (err) => {
      console.error('WebSocket error:', err);
      setError('Connection error');
    };

    ws.onclose = () => {
      console.log('WebSocket disconnected');
      setConnected(false);
      // Attempt reconnect after 5 seconds
      setTimeout(() => {
        if (wsRef.current?.readyState === WebSocket.CLOSED) {
          // Trigger reconnect by updating state
          setDataPoints((prev) => prev);
        }
      }, 5000);
    };

    return () => {
      ws.close();
      wsRef.current = null;
    };
  }, [vehicleId, columns, wsUrl]);

  // Send ping every 30 seconds to keep connection alive
  useEffect(() => {
    const interval = setInterval(() => {
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ type: 'ping' }));
      }
    }, 30000);
    return () => clearInterval(interval);
  }, []);

  // Transform data for chart
  const chartLabels = dataPoints.map((p) => new Date(p.timestamp).toLocaleTimeString());
  
  const chartDatasets = columns.map((col, index) => ({
    label: col.replace('dynamic:', '').replace('static:', ''),
    data: dataPoints.map((p) => {
      const val = p.values[col];
      return val !== undefined ? parseFloat(val) : null;
    }),
    borderColor: COLORS[index % COLORS.length],
    backgroundColor: COLORS[index % COLORS.length] + '33',
    fill: false,
    tension: 0.2,
    pointRadius: 2,
    pointHoverRadius: 5,
    spanGaps: true,
  }));

  return (
    <div className="w-full h-96 bg-white rounded-lg border border-gray-200 p-4">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-lg font-semibold text-gray-900">Live Telemetry: {vehicleId}</h3>
        <div className="flex items-center gap-4 text-sm">
          <span className={`flex items-center gap-1 ${connected ? 'text-green-600' : 'text-red-600'}`}>
            <span className={`w-2 h-2 rounded-full ${connected ? 'bg-green-500' : 'bg-red-500'}`} />
            {connected ? 'Live' : 'Disconnected'}
          </span>
          {error && <span className="text-red-500">{error}</span>}
        </div>
      </div>
      
      <div className="relative h-[350px]">
        <Line
          data={{
            labels: chartLabels,
            datasets: chartDatasets,
          }}
          options={chartOptions}
        />
      </div>

      <div className="mt-4 flex flex-wrap gap-4 text-xs text-gray-600">
        {columns.map((col, index) => (
          <span key={col} className="flex items-center gap-1">
            <span className="w-3 h-3 rounded" style={{ backgroundColor: COLORS[index % COLORS.length] }} />
            {col.replace('dynamic:', '').replace('static:', '')}
          </span>
        ))}
      </div>
    </div>
  );
}

const COLORS = [
  '#3B82F6', // blue
  '#10B981', // emerald
  '#F59E0B', // amber
  '#EF4444', // red
  '#8B5CF6', // violet
  '#EC4899', // pink
  '#06B6D4', // cyan
  '#84CC16', // lime
];
