'use client';
import { useEffect, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Play, Plus, Square } from 'lucide-react';

export interface DemoStatus {
  running: boolean;
  published: number;
}

/** Keycloak-configured VIN pool (see local-dev keycloak realm setup). */
export const VIN_POOL = Array.from({ length: 10 }, (_, i) => `VIN${1001 + i}`);

interface DemoControlBarProps {
  vin: string;
  onVinChange: (vin: string) => void;
  running: boolean;
  busy: boolean;
  onStart: () => void;
  onStop: () => void;
}

async function fetchVehicles(): Promise<string[]> {
  const res = await fetch('/api/demo/vehicles', { cache: 'no-store' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = (await res.json()) as { vehicles?: string[] };
  return data.vehicles ?? [];
}

/**
 * Control strip for /demo: vehicle picker (chart-service vehicles + VIN pool),
 * "New vehicle" (refetches /api/demo/vehicles and jumps to a random one),
 * Start/Stop for the NATS simulator and a live status badge. Errors surface as
 * sonner toasts (e.g. 503 when the simulator/chart service is down).
 */
export function DemoControlBar({ vin, onVinChange, running, busy, onStart, onStop }: DemoControlBarProps) {
  const [vehicles, setVehicles] = useState<string[]>([]);

  useEffect(() => {
    fetchVehicles()
      .then(setVehicles)
      .catch(async (e: unknown) => {
        const { toast } = await import('sonner');
        toast.error(e instanceof Error ? e.message : 'Failed to load vehicles');
      });
  }, []);

  const options = Array.from(new Set([vin, ...vehicles, ...VIN_POOL]));

  const handleNewVehicle = async () => {
    try {
      const fresh = await fetchVehicles();
      setVehicles(fresh);
      const candidates = Array.from(new Set([vin, ...fresh, ...VIN_POOL])).filter((v) => v !== vin);
      if (candidates.length === 0) return;
      const picked = candidates[Math.floor(Math.random() * candidates.length)];
      if (picked !== vin) onVinChange(picked);
    } catch (e) {
      const { toast } = await import('sonner');
      toast.error(e instanceof Error ? e.message : 'Failed to load vehicles');
    }
  };

  return (
    <Card className="flex flex-wrap items-center gap-3 p-3">
      <Select
        value={vin}
        onValueChange={(v) => {
          if (v) onVinChange(v);
        }}
      >
        <SelectTrigger className="w-[220px]">
          <SelectValue placeholder="Select vehicle" />
        </SelectTrigger>
        <SelectContent>
          {options.map((v) => (
            <SelectItem key={v} value={v}>
              {v}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Button variant="secondary" size="sm" onClick={handleNewVehicle}>
        <Plus />
        New vehicle
      </Button>

      {running ? (
        <Button variant="destructive" size="sm" onClick={onStop} disabled={busy}>
          <Square />
          Stop
        </Button>
      ) : (
        <Button size="sm" onClick={onStart} disabled={busy}>
          <Play />
          Start
        </Button>
      )}

      <Badge variant={running ? 'default' : 'secondary'} className="ml-auto gap-1.5">
        <span className="relative flex h-2 w-2" aria-hidden="true">
          {running && (
            <span className="live-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400" />
          )}
          <span
            className={`relative inline-flex h-2 w-2 rounded-full ${running ? 'bg-emerald-400' : 'bg-gray-400'}`}
          />
        </span>
        {running ? 'Running' : 'Idle'}
      </Badge>
    </Card>
  );
}
