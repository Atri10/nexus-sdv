'use client';
import Link from 'next/link';
import Image from 'next/image';
import { usePathname } from 'next/navigation';
import { useSession, signOut } from 'next-auth/react';
import { useScoringMessages } from '@/hooks/useScoringMessages';
import logo from '@/assets/logo.GlIrfdpi.png';

export default function Sidebar() {
  const pathname = usePathname();
  const { data: session } = useSession();
  const messages = useScoringMessages();

  const fleetActive =
    pathname === '/fleet' || pathname.startsWith('/device/');

  const demoActive = pathname === '/demo' || pathname.startsWith('/demo/');

  const navClass = (active: boolean) =>
    `relative flex items-center px-3 py-2 rounded text-sm transition-colors ${
      active
        ? 'glow-cyan bg-cyan-400/10 dark:text-cyan-300 text-cyan-700'
        : 'text-foreground/85 hover:bg-muted/60 dark:hover:text-cyan-200 hover:text-cyan-700'
    }`;

  return (
    <aside className="hud-panel w-56 flex flex-col shrink-0 border-y-0 border-l-0">
      <div id="nexuslogo" className="px-2 py-1 flex items-center gap-3 border-b border-border/70">
        <Image src={logo} alt="Nexus SDV logo" className="w-auto shrink-0" style={{ height: '3.5rem' }} />
        <span className="font-display text-xl font-bold tracking-wide dark:text-cyan-300 text-cyan-700 glow-text">
          NEXUS SDV
        </span>
      </div>

      <nav aria-label="Main navigation" className="flex-1 px-2 py-1 space-y-1">
        <Link
          href="/fleet"
          className={navClass(fleetActive)}
          aria-current={fleetActive ? 'page' : undefined}
        >
          {fleetActive && (
            <span
              aria-hidden="true"
              className="absolute left-0 top-1/2 -translate-y-1/2 h-5 w-0.5 rounded bg-cyan-400"
            />
          )}
          Fleet
        </Link>
        <Link
          href="/demo"
          className={navClass(demoActive)}
          aria-current={demoActive ? 'page' : undefined}
        >
          {demoActive && (
            <span
              aria-hidden="true"
              className="absolute left-0 top-1/2 -translate-y-1/2 h-5 w-0.5 rounded bg-cyan-400"
            />
          )}
          Demo
        </Link>
      </nav>

      <div id="scoremessages" className="px-4 py-4 border-t border-border/70">
        <p className="text-xs font-semibold uppercase mb-2 text-foreground/70">
          Scoring Events
        </p>
        <textarea
          readOnly
          value={messages.map((raw) => {
            try {
              const { vehicle, score, message } = JSON.parse(raw);
              return `${vehicle} - ${score} - ${message}`;
            } catch {
              return raw;
            }
          }).join('\n')}
          className="w-full h-96 bg-transparent text-xs font-mono rounded p-2 resize-none overflow-y-auto border border-border/70 text-foreground/90 focus:outline-none focus:border-cyan-400/50"
          placeholder="No events yet…"
        />
      </div>

      <div className="px-4 py-4 border-t border-border/70 text-sm text-foreground/85">
        <p className="truncate mb-2">{session?.user?.email}</p>
        <button
          type="button"
          onClick={() => signOut({ callbackUrl: '/auth/signin' })}
          className="text-muted-foreground hover:text-cyan-300 transition-colors"
        >
          Sign out
        </button>
      </div>
    </aside>
  );
}
