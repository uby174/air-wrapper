'use client';

import { useState } from 'react';
import type { ChatResponse } from '@ai-wrapper/shared';
import { Button } from '@/components/ui/button';

export const ChatPanel = () => {
  const [message, setMessage] = useState('');
  const [provider, setProvider] = useState<'openai' | 'anthropic' | 'google'>('openai');
  const [reply, setReply] = useState('');
  const [loading, setLoading] = useState(false);

  const submit = async () => {
    if (!message.trim()) return;
    setLoading(true);
    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message, provider })
      });
      const data = (await response.json()) as ChatResponse;
      setReply(data.reply);
    } catch (error) {
      setReply(error instanceof Error ? error.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-4 rounded-xl border border-border p-4">
      <div className="flex items-center gap-3">
        <select
          value={provider}
          onChange={(event) => setProvider(event.target.value as 'openai' | 'anthropic' | 'google')}
          className="h-10 rounded-md border border-border bg-white px-3 text-sm"
        >
          <option value="openai">OpenAI</option>
          <option value="anthropic">Anthropic</option>
          <option value="google">Google</option>
        </select>
        <input
          value={message}
          onChange={(event) => setMessage(event.target.value)}
          placeholder="Ask something..."
          className="h-10 flex-1 rounded-md border border-border px-3 text-sm"
        />
        <Button onClick={submit} disabled={loading}>
          {loading ? 'Sending...' : 'Send'}
        </Button>
      </div>
      <div className="min-h-24 rounded-md bg-secondary p-3 text-sm text-secondary-foreground">
        {reply || 'Reply will appear here.'}
      </div>
    </div>
  );
};
