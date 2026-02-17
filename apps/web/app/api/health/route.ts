import { NextResponse } from 'next/server';
import { callApi } from '@/lib/api';

export async function GET() {
  try {
    const upstream = await callApi<{ ok: true; service: string }>('/health');
    return NextResponse.json({ ok: true, web: 'ok', upstream });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : 'unknown error' },
      { status: 500 }
    );
  }
}
