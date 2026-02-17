import { chatRequestSchema, type ChatResponse } from '@ai-wrapper/shared';
import { NextResponse } from 'next/server';
import { callApi } from '@/lib/api';

export async function POST(request: Request) {
  try {
    const body = chatRequestSchema.parse(await request.json());
    const authorization = request.headers.get('authorization') ?? undefined;
    const response = await callApi<ChatResponse>('/v1/chat', {
      method: 'POST',
      headers: authorization ? { Authorization: authorization } : undefined,
      body: JSON.stringify(body)
    });
    return NextResponse.json(response);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Invalid request' },
      { status: 400 }
    );
  }
}
