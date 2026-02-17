'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { AppShell } from '@/components/app-shell';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  createPrivacyRequest,
  deleteMyAccount,
  exportMyData,
  getPrivacyStatus,
  type PrivacyRequestType,
  type PrivacyStatusResponse,
  updatePrivacyConsent
} from '@/lib/api';
import { clearLocalSession, getLocalSession } from '@/lib/session';

const formatDateTime = (value: string | null): string => {
  if (!value) return 'Not provided';
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return value;
  return new Date(timestamp).toLocaleString();
};

const toJsonDownload = (filename: string, payload: unknown): void => {
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
};

export default function PrivacyPage() {
  const router = useRouter();
  const [status, setStatus] = useState<PrivacyStatusResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [savingConsent, setSavingConsent] = useState(false);
  const [requesting, setRequesting] = useState(false);
  const [exportingData, setExportingData] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState('');
  const [requestType, setRequestType] = useState<PrivacyRequestType>('portability');
  const [requestNote, setRequestNote] = useState('');
  const [marketingConsent, setMarketingConsent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const policyVersion = process.env.NEXT_PUBLIC_PRIVACY_POLICY_VERSION ?? '2026-02-15';
  const termsVersion = process.env.NEXT_PUBLIC_TERMS_VERSION ?? '2026-02-15';

  const loadStatus = async () => {
    setLoading(true);
    try {
      const response = await getPrivacyStatus();
      setStatus(response);
      setMarketingConsent(response.consent.marketing_consent);
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Failed to load privacy status.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!getLocalSession()) {
      router.replace('/login');
      return;
    }
    void loadStatus();
  }, [router]);

  const canDelete = useMemo(() => deleteConfirm.trim().toUpperCase() === 'DELETE', [deleteConfirm]);

  const saveConsent = async () => {
    if (savingConsent) return;
    setSavingConsent(true);
    setError(null);
    setSuccess(null);
    try {
      await updatePrivacyConsent({
        privacyPolicyVersion: policyVersion,
        termsVersion,
        marketingConsent
      });
      await loadStatus();
      setSuccess(`Consent saved for policy version ${policyVersion}.`);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Failed to save consent.');
    } finally {
      setSavingConsent(false);
    }
  };

  const submitRequest = async () => {
    if (requesting) return;
    setRequesting(true);
    setError(null);
    setSuccess(null);

    try {
      const created = await createPrivacyRequest({
        requestType,
        note: requestNote.trim() || undefined
      });
      setSuccess(`Request ${created.id} created (${created.request_type}).`);
      setRequestNote('');
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Failed to create privacy request.');
    } finally {
      setRequesting(false);
    }
  };

  const downloadExport = async () => {
    if (exportingData) return;
    setExportingData(true);
    setError(null);
    setSuccess(null);
    try {
      const payload = await exportMyData();
      const date = new Date().toISOString().slice(0, 10);
      toJsonDownload(`ai-wrapper-export-${date}.json`, payload);
      setSuccess('Data export generated and downloaded.');
    } catch (exportError) {
      setError(exportError instanceof Error ? exportError.message : 'Failed to export data.');
    } finally {
      setExportingData(false);
    }
  };

  const deleteAccount = async () => {
    if (!canDelete || deleting) return;
    setDeleting(true);
    setError(null);
    setSuccess(null);

    try {
      const response = await deleteMyAccount();
      if (!response.deleted) {
        throw new Error(response.message || 'Account deletion did not complete.');
      }
      clearLocalSession();
      router.replace('/login');
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : 'Failed to delete account.');
    } finally {
      setDeleting(false);
    }
  };

  return (
    <AppShell title="Privacy & GDPR" subtitle="Consent, export, and deletion controls for data subject rights.">
      <div className="grid gap-5 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Consent</CardTitle>
            <CardDescription>Record acceptance of privacy policy and terms before processing data.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Policy version: <span className="font-medium text-foreground">{policyVersion}</span>
            </p>
            <p className="text-sm text-muted-foreground">
              Terms version: <span className="font-medium text-foreground">{termsVersion}</span>
            </p>
            <p className="text-sm text-muted-foreground">
              Last consent: <span className="font-medium text-foreground">{formatDateTime(status?.consent.consented_at ?? null)}</span>
            </p>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={marketingConsent}
                onChange={(event) => setMarketingConsent(event.target.checked)}
                className="h-4 w-4"
              />
              I agree to product updates (optional marketing consent).
            </label>
            <Button onClick={() => void saveConsent()} disabled={savingConsent || loading}>
              {savingConsent ? 'Saving...' : 'Save Consent'}
            </Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Self-Service Data Rights</CardTitle>
            <CardDescription>Download your data or open formal GDPR request tickets.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <Button variant="secondary" onClick={() => void downloadExport()} disabled={exportingData || loading}>
              {exportingData ? 'Preparing Export...' : 'Export My Data (JSON)'}
            </Button>

            <div className="space-y-2">
              <Label htmlFor="request-type">Request type</Label>
              <select
                id="request-type"
                value={requestType}
                onChange={(event) => setRequestType(event.target.value as PrivacyRequestType)}
                className="h-10 w-full rounded-md border border-input bg-white px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              >
                <option value="portability">Portability</option>
                <option value="rectification">Rectification</option>
                <option value="restriction">Restriction</option>
                <option value="objection">Objection</option>
              </select>
            </div>

            <div className="space-y-2">
              <Label htmlFor="request-note">Note (optional)</Label>
              <Input
                id="request-note"
                value={requestNote}
                onChange={(event) => setRequestNote(event.target.value)}
                placeholder="Example: Please correct my company name."
              />
            </div>
            <Button onClick={() => void submitRequest()} disabled={requesting || loading}>
              {requesting ? 'Submitting...' : 'Create Privacy Request'}
            </Button>
          </CardContent>
        </Card>
      </div>

      <Card className="border-red-200">
        <CardHeader>
          <CardTitle className="text-red-700">Delete Account</CardTitle>
          <CardDescription>
            This permanently removes your user record and all associated jobs/documents/chunks/usage events.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-muted-foreground">Type <span className="font-medium text-foreground">DELETE</span> to confirm.</p>
          <Input value={deleteConfirm} onChange={(event) => setDeleteConfirm(event.target.value)} placeholder="DELETE" />
          <Button
            variant="secondary"
            className="border border-red-300 text-red-700 hover:bg-red-50"
            onClick={() => void deleteAccount()}
            disabled={!canDelete || deleting || loading}
          >
            {deleting ? 'Deleting...' : 'Delete My Account'}
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Current Data Profile</CardTitle>
          <CardDescription>Quick operational view of data retention and account metadata.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          <p>
            <span className="font-medium">User:</span> {status?.user.email ?? 'Loading...'}
          </p>
          <p>
            <span className="font-medium">Plan:</span> {status?.user.plan ?? 'Loading...'}
          </p>
          <p>
            <span className="font-medium">Account created:</span> {formatDateTime(status?.user.created_at ?? null)}
          </p>
          <p>
            <span className="font-medium">Retention:</span>{' '}
            Jobs {status?.retention.jobsDays ?? '-'}d | Documents {status?.retention.documentsDays ?? '-'}d | Usage{' '}
            {status?.retention.usageEventsDays ?? '-'}d
          </p>
        </CardContent>
      </Card>

      {loading ? <p className="text-sm text-muted-foreground">Loading privacy controls...</p> : null}
      {error ? <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p> : null}
      {success ? <p className="rounded-md border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-700">{success}</p> : null}
    </AppShell>
  );
}
