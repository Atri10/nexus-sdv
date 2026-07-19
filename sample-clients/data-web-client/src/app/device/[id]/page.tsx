'use client';
import { use, useEffect, useState } from 'react';
import AppLayout from '@/components/app-layout';
import DataTable from '@/components/data-table';
import TimeRangeSelector from '@/components/time-range-selector';
import type { TimeRange } from '@/types/telemetry';
import { extractGpsPoints } from '@/lib/gps';
import GpsTrackMap from '@/components/gps-track-map';
import TelemetryChart from '@/components/telemetry-chart';
import { ChartControls } from '@/components/chart-controls';
import { StateView } from '@/components/state-view';
import { useTelemetryData } from '@/hooks/use-telemetry-data';
import { useChartTheme } from '@/hooks/use-chart-theme';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Badge } from '@/components/ui/badge';

export default function DevicePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [range, setRange] = useState<TimeRange>('1h');
  const [type, setType] = useState<'line' | 'area' | 'bar'>('line');
  const [axisMode, setAxisMode] = useState<'single' | 'dual'>('single');
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [compareVins, setCompareVins] = useState<string[]>([]);
  const [resetZoomToken, setResetZoomToken] = useState(0);
  const [mapsConfig, setMapsConfig] = useState<{ apiKey: string; mapId: string } | null>(null);

  const theme = useChartTheme();
  const { series, loading, error, refetch } = useTelemetryData({ vin: id, range, compareVins });

  useEffect(() => {
    fetch('/api/maps-config')
      .then((r) => r.json() as Promise<{ apiKey: string; mapId: string }>)
      .then(setMapsConfig)
      .catch(() => { /* maps config unavailable */ });
  }, []);

  const toggle = (key: string) =>
    setHidden((prev) => {
      const n = new Set(prev);
      n.has(key) ? n.delete(key) : n.add(key);
      return n;
    });

  const stateView = error ? 'error' : loading ? 'loading' : series.length === 0 ? 'empty' : 'ready';
  const tableColumnKeys = ['timestamp', ...Array.from(new Set(series.flatMap((s) => s.column)))];
  const tableData = series.length
    ? series[0].points.map((_, i) => ({
        timestamp: new Date(series[0].points[i].x).toLocaleString(),
        ...Object.fromEntries(series.map((s) => [s.column, s.points[i]?.y ?? '—'])),
      }))
    : [];
  const gpsColumns = Array.from(new Set(series.flatMap((s) => s.column)));
  const gpsRows = tableData.map((r) => ({ timestamp: r.timestamp, values: r as Record<string, string | number> }));
  const gpsPoints = extractGpsPoints({ rows: gpsRows, columns: gpsColumns } as any);

  return (
    <AppLayout>
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <h1 className="text-xl font-semibold">Vehicle {id}</h1>
            <Badge variant={error ? 'destructive' : 'default'}>{error ? 'Error' : loading ? 'Loading' : 'Live'}</Badge>
          </div>
          <TimeRangeSelector value={range} onChange={setRange} />
        </div>

        <ChartControls
          type={type} onTypeChange={setType}
          series={series} hidden={hidden} onToggle={toggle}
          axisMode={axisMode} onAxisModeChange={setAxisMode}
          onResetZoom={() => setResetZoomToken((t) => t + 1)}
          onAddCompare={(v) => setCompareVins((c) => c.includes(v) ? c : [...c, v])}
          compareVins={compareVins}
        />

        <Card>
          <CardHeader><CardTitle>Telemetry</CardTitle></CardHeader>
          <CardContent>
            <StateView state={stateView} onRetry={refetch}>
              <TelemetryChart vehicleId={id} series={series} type={type} axisMode={axisMode} hidden={hidden} theme={theme} resetZoomToken={resetZoomToken} />
            </StateView>
          </CardContent>
        </Card>

        <Tabs defaultValue="table">
          <TabsList>
            <TabsTrigger value="table">Table</TabsTrigger>
            <TabsTrigger value="map">Map</TabsTrigger>
          </TabsList>
          <TabsContent value="table">
            <DataTable columnKeys={tableColumnKeys} data={tableData} />
          </TabsContent>
          <TabsContent value="map">
            <GpsTrackMap points={gpsPoints} apiKey={mapsConfig?.apiKey ?? ''} mapId={mapsConfig?.mapId} />
          </TabsContent>
        </Tabs>
      </div>
    </AppLayout>
  );
}
