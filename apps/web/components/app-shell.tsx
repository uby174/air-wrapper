'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { getLocalSession, clearLocalSession } from '@/lib/session';
import { cn } from '@/lib/utils';

const navItems = [
  { href: '/dashboard', label: 'Dashboard' },
  { href: '/history', label: 'History' },
  { href: '/privacy', label: 'Privacy' }
];

interface AppShellProps {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}

export const AppShell = ({ title, subtitle, children }: AppShellProps) => {
  const pathname = usePathname();
  const router = useRouter();
  const [email, setEmail] = useState<string | null>(null);

  useEffect(() => {
    const session = getLocalSession();
    setEmail(session?.email ?? null);
  }, [pathname]);

  return (
    <main className="min-h-screen bg-gradient-to-b from-slate-50 to-white">
      <div className="mx-auto flex max-w-6xl flex-col gap-6 px-4 py-6 sm:px-6 lg:px-8">
        <header className="rounded-xl border border-border bg-white/95 p-4 backdrop-blur sm:p-5">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="space-y-1">
              <p className="text-xs uppercase tracking-wide text-muted-foreground">AI Wrapper</p>
              <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
              {subtitle ? <p className="text-sm text-muted-foreground">{subtitle}</p> : null}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {navItems.map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  className={cn(
                    'rounded-md border px-3 py-2 text-sm',
                    pathname === item.href ? 'border-primary text-primary' : 'border-border text-muted-foreground'
                  )}
                >
                  {item.label}
                </Link>
              ))}
              {email ? (
                <Button
                  variant="secondary"
                  onClick={() => {
                    clearLocalSession();
                    router.push('/login');
                  }}
                >
                  Logout
                </Button>
              ) : (
                <Link href="/login" className="rounded-md border border-border px-3 py-2 text-sm text-muted-foreground">
                  Login
                </Link>
              )}
            </div>
          </div>
        </header>
        {children}
      </div>
    </main>
  );
};
