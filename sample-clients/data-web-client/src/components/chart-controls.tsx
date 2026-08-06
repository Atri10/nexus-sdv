'use client';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Input } from '@/components/ui/input';
import { Card } from '@/components/ui/card';
import type { ChartSeries } from '@/lib/telemetry-chart-utils';

export function ChartControls(props: {
  type: 'line' | 'area' | 'bar';
  onTypeChange: (t: 'line' | 'area' | 'bar') => void;
  series: ChartSeries[];
  hidden: Set<string>;
  onToggle: (key: string) => void;
  axisMode: 'single' | 'dual';
  onAxisModeChange: (m: 'single' | 'dual') => void;
  onResetZoom: () => void;
  onAddCompare: (vin: string) => void;
  compareVins: string[];
}) {
  const [vin, setVin] = useState('');
  return (
    <Card className="flex flex-wrap items-center gap-3 p-3">
      <Select value={props.type} onValueChange={(v) => props.onTypeChange(v as 'line' | 'area' | 'bar')}>
        <SelectTrigger className="w-[120px]"><SelectValue placeholder="Type" /></SelectTrigger>
        <SelectContent>
          <SelectItem value="line">Line</SelectItem>
          <SelectItem value="area">Area</SelectItem>
          <SelectItem value="bar">Bar</SelectItem>
        </SelectContent>
      </Select>

      <div className="flex flex-wrap items-center gap-2">
        {props.series.map((s) => (
          <button key={s.key} onClick={() => props.onToggle(s.key)}
            type="button"
            className={`flex cursor-pointer items-center gap-1.5 rounded-md px-2 py-1 text-xs transition-all duration-200 hover:scale-[1.02] active:scale-[0.98] hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${props.hidden.has(s.key) ? 'opacity-40 line-through' : ''}`}>
            <span className="h-3 w-3 shrink-0 rounded" style={{ backgroundColor: s.color }} />
            {s.label}
          </button>
        ))}
      </div>

      <div className="flex items-center gap-2">
        <span className="text-xs text-muted-foreground">Dual axis</span>
        <Switch checked={props.axisMode === 'dual'} onCheckedChange={(c) => props.onAxisModeChange(c ? 'dual' : 'single')} />
      </div>

      <Button variant="outline" size="sm" className="transition-transform duration-200 hover:scale-[1.02] active:scale-[0.98]" onClick={props.onResetZoom}>Reset zoom</Button>

      <form onSubmit={(e) => { e.preventDefault(); if (vin.trim()) { props.onAddCompare(vin.trim()); setVin(''); } }}
        className="flex items-center gap-2">
        <Input value={vin} onChange={(e) => setVin(e.target.value)} placeholder="Compare VIN…" className="w-[140px]" />
        <Button type="submit" size="sm" variant="secondary" className="transition-transform duration-200 hover:scale-[1.02] active:scale-[0.98]">Add</Button>
      </form>
    </Card>
  );
}
