'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { AppShell } from '@/components/app-shell';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { listRecentJobs, type JobListItem } from '@/lib/api';
import { getLocalSession } from '@/lib/session';
import { verticalNameById } from '@/lib/verticals';

const formatDateTime = (value: string): string => {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return value;
  return new Date(timestamp).toLocaleString();
};

const statusVariant = (status: string): 'secondary' | 'warning' | 'success' | 'destructive' => {
  if (status === 'succeeded') return 'success';
  if (status === 'failed') return 'destructive';
  if (status === 'running') return 'warning';
  return 'secondary';
};

export default function HistoryPage() {
  const router = useRouter();
  const [items, setItems] = useState<JobListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      const response = await listRecentJobs(20);
      setItems(response.items);
      setError(null);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Failed to load job history.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!getLocalSession()) {
      router.replace('/login');
      return;
    }
    void load();
  }, [router]);

  return (
    <AppShell title="History" subtitle="Last 20 jobs across your local API environment.">
      <Card>
        <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <CardTitle>Recent Jobs</CardTitle>
            <CardDescription>Includes queued, running, succeeded, and failed jobs.</CardDescription>
          </div>
          <Button variant="secondary" onClick={() => void load()} disabled={loading}>
            {loading ? 'Refreshing...' : 'Refresh'}
          </Button>
        </CardHeader>
        <CardContent className="space-y-3">
          {error ? <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p> : null}
          {!loading && items.length === 0 ? <p className="text-sm text-muted-foreground">No jobs found yet.</p> : null}

          {items.map((item) => (
            <div key={item.id} className="rounded-lg border border-border p-3">
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                <div className="space-y-1">
                  <p className="text-sm font-semibold">{verticalNameById(item.use_case)}</p>
                  <p className="text-xs text-muted-foreground">{item.id}</p>
                </div>
                <div className="flex items-center gap-2">
                  <Badge variant={statusVariant(item.status)}>{item.status}</Badge>
                  <Link href={`/jobs/${item.id}`} className="rounded-md border border-border px-2 py-1 text-sm">
                    Open
                  </Link>
                </div>
              </div>
              <p className="mt-2 text-xs text-muted-foreground">Created: {formatDateTime(item.created_at)}</p>
              {item.error ? <p className="mt-1 text-xs text-red-600">Error: {item.error}</p> : null}
            </div>
          ))}
        </CardContent>
      </Card>
    </AppShell>
  );
}
