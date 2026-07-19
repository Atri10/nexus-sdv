import type { ReactNode } from 'react';
import Sidebar from './sidebar';
import { DeviceSearch } from './device-search';
import { ThemeToggle } from '@/components/theme-toggle';

export default function AppLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-screen bg-white">
      <Sidebar />
      <main className="flex-1 overflow-auto">
        <header className="flex items-center justify-between border-b px-4 py-2">
          <DeviceSearch />
          <ThemeToggle />
        </header>
        <div className="p-6">{children}</div>
      </main>
    </div>
  );
}
