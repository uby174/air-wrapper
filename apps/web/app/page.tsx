import Link from 'next/link';
import { AppShell } from '@/components/app-shell';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

export default function HomePage() {
  return (
    <AppShell title="AI Wrapper" subtitle="Production-oriented async job workflow for vertical AI use cases.">
      <Card>
        <CardHeader>
          <CardTitle>Start Workflow</CardTitle>
          <CardDescription>Login, create a job, monitor status, and inspect citations.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-3">
          <Button asChild>
            <Link href="/login">Login</Link>
          </Button>
          <Button asChild variant="secondary">
            <Link href="/dashboard">Go to Dashboard</Link>
          </Button>
          <Button asChild variant="secondary">
            <Link href="/history">View History</Link>
          </Button>
        </CardContent>
      </Card>
    </AppShell>
  );
}
