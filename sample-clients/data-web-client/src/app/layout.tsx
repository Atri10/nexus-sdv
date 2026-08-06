import type { Metadata } from 'next';
import { Orbitron, JetBrains_Mono } from 'next/font/google';
import './globals.css';
import { SessionProvider } from './session-provider';
import { ThemeProvider } from '@/components/theme-provider';
import { Toaster } from '@/components/ui/sonner';

const orbitron = Orbitron({
  variable: '--font-orbitron',
  subsets: ['latin'],
  weight: ['700', '900'],
});

const jetbrainsMono = JetBrains_Mono({
  variable: '--font-jb-mono',
  subsets: ['latin'],
  weight: ['400', '500', '700'],
});

export const metadata: Metadata = { title: 'Nexus SDV' };

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${orbitron.variable} ${jetbrainsMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
          <SessionProvider>{children}</SessionProvider>
          <Toaster richColors />
        </ThemeProvider>
      </body>
    </html>
  );
}
