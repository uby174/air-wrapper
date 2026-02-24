'use client';

import { ChangeEvent, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { AppShell } from '@/components/app-shell';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { createJob } from '@/lib/api';
import { getLocalSession } from '@/lib/session';
import { verticalOptions } from '@/lib/verticals';

type InputMode = 'text' | 'pdf';

const toDataUrl = (file: File): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(new Error('Failed to read the PDF file.'));
    reader.readAsDataURL(file);
  });

export default function DashboardPage() {
  const router = useRouter();
  const [useCase, setUseCase] = useState(verticalOptions[0]?.id ?? 'legal_contract_analysis');
  const [mode, setMode] = useState<InputMode>('text');
  const [textInput, setTextInput] = useState('');
  const [pdfName, setPdfName] = useState<string | null>(null);
  const [pdfDataUrl, setPdfDataUrl] = useState<string | null>(null);
  const [loadingPdf, setLoadingPdf] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!getLocalSession()) {
      router.replace('/login');
    }
  }, [router]);

  const canSubmit = useMemo(() => {
    if (mode === 'text') return textInput.trim().length > 0;
    return Boolean(pdfDataUrl);
  }, [mode, textInput, pdfDataUrl]);

  const onSelectPdf = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    setError(null);
    setLoadingPdf(true);

    try {
      if (!file.name.toLowerCase().endsWith('.pdf')) {
        throw new Error('Please upload a .pdf file.');
      }

      const dataUrl = await toDataUrl(file);
      setPdfName(file.name);
      setPdfDataUrl(dataUrl);
    } catch (uploadError) {
      setPdfName(null);
      setPdfDataUrl(null);
      setError(uploadError instanceof Error ? uploadError.message : 'Unable to load the PDF file.');
    } finally {
      setLoadingPdf(false);
    }
  };

  const submitJob = async () => {
    if (!canSubmit || submitting) return;
    setError(null);
    setSubmitting(true);

    try {
      const payload =
        mode === 'text'
          ? {
              use_case: useCase,
              input: {
                type: 'text' as const,
                text: textInput.trim()
              },
              options: {
                locale: typeof navigator !== 'undefined' ? navigator.language : 'en-US'
              }
            }
          : {
              use_case: useCase,
              input: {
                type: 'pdf' as const,
                storageUrl: String(pdfDataUrl)
              },
              options: {
                locale: typeof navigator !== 'undefined' ? navigator.language : 'en-US'
              }
            };

      const created = await createJob(payload);
      router.push(`/jobs/${created.id}`);
    } catch (submitError) {
      const message = submitError instanceof Error ? submitError.message : 'Failed to create job.';
      if (message.includes('Privacy consent is required')) {
        setError('Privacy consent is required before creating jobs. Open the Privacy tab and click "Save Consent".');
      } else {
        setError(message);
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <AppShell title="Dashboard" subtitle="3-step flow: choose use case, add input, run job.">
      <div className="grid gap-5 lg:grid-cols-3">
        <Card className="lg:col-span-1">
          <CardHeader>
            <CardTitle>Step 1. Use Case</CardTitle>
            <CardDescription>Select the analysis template.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <Label htmlFor="use-case">Use case</Label>
            <select
              id="use-case"
              value={useCase}
              onChange={(event) => setUseCase(event.target.value)}
              className="h-10 w-full rounded-md border border-input bg-white px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            >
              {verticalOptions.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.name}
                </option>
              ))}
            </select>
            <p className="text-sm text-muted-foreground">
              {verticalOptions.find((option) => option.id === useCase)?.description}
            </p>
          </CardContent>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Step 2. Input</CardTitle>
            <CardDescription>Paste text or upload a PDF.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex flex-wrap gap-2">
              <Button variant={mode === 'text' ? 'default' : 'secondary'} onClick={() => setMode('text')}>
                Paste Text
              </Button>
              <Button variant={mode === 'pdf' ? 'default' : 'secondary'} onClick={() => setMode('pdf')}>
                Upload PDF
              </Button>
            </div>

            {mode === 'text' ? (
              <div className="space-y-2">
                <Label htmlFor="text-input">Text input</Label>
                <Textarea
                  id="text-input"
                  value={textInput}
                  onChange={(event) => setTextInput(event.target.value)}
                  placeholder="Paste content to analyze..."
                  className="min-h-52"
                />
              </div>
            ) : (
              <div className="space-y-2">
                <Label htmlFor="pdf-input">PDF file</Label>
                <Input id="pdf-input" type="file" accept="application/pdf,.pdf" onChange={onSelectPdf} />
                <p className="text-sm text-muted-foreground">
                  {loadingPdf ? 'Reading file...' : pdfName ? `Loaded: ${pdfName}` : 'No PDF selected yet.'}
                </p>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Step 3. Run Job</CardTitle>
          <CardDescription>Create the job and track progress in real time.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-sm text-muted-foreground">
            Selected: <span className="font-medium text-foreground">{useCase}</span> | Input:{' '}
            <span className="font-medium text-foreground">{mode.toUpperCase()}</span>
          </p>
          <Button disabled={!canSubmit || submitting || loadingPdf} onClick={submitJob}>
            {submitting ? 'Creating Job...' : 'Create Job'}
          </Button>
        </CardContent>
      </Card>

      {error ? <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p> : null}
    </AppShell>
  );
}
