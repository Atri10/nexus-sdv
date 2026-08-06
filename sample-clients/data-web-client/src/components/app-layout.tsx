import type { ReactNode } from 'react';
import Sidebar from './sidebar';
import { DeviceSearch } from './device-search';
import { ThemeToggle } from '@/components/theme-toggle';

export default function AppLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-screen">
      <div
        id="deck-backdrop"
        aria-hidden="true"
        className="pointer-events-none fixed inset-0 -z-10 overflow-hidden"
      >
        <div className="deck-starfield" />
        <div className="deck-vignette" />
        <div className="deck-grid" />
      </div>
      <Sidebar />
      <main className="relative flex-1 overflow-auto">
        <header className="hud-panel flex items-center justify-between gap-4 px-4 py-2">
          <h1 className="font-display text-sm font-bold tracking-[0.3em] dark:text-cyan-400 text-cyan-700 glow-text">
            NEXUS&nbsp;SDV
          </h1>
          <div className="flex items-center gap-2">
            <DeviceSearch />
            <ThemeToggle />
          </div>
        </header>
        <div className="p-6">{children}</div>
      </main>
    </div>
  );
}
