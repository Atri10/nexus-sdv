'use client';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';
import { AlertCircle } from 'lucide-react';
import type { ReactNode } from 'react';

export function StateView({ state, onRetry, children }: { state: 'loading' | 'empty' | 'error' | 'ready'; onRetry?: () => void; children: ReactNode }) {
  if (state === 'loading') return <Skeleton className="h-[400px] w-full rounded-lg" />;
  if (state === 'empty') return (
    <div className="flex h-[400px] w-full items-center justify-center rounded-lg border border-dashed">
      <p className="text-muted-foreground">No telemetry for this vehicle yet — publish data to see it.</p>
    </div>
  );
  if (state === 'error') return (
    <div className="flex h-[400px] w-full flex-col items-center justify-center gap-3 rounded-lg border border-destructive/40">
      <AlertCircle className="h-6 w-6 text-destructive" />
      <p className="text-destructive">Failed to load telemetry.</p>
      {onRetry && <Button variant="outline" onClick={onRetry}>Retry</Button>}
    </div>
  );
  return <>{children}</>;
}
