import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'AI Wrapper',
  description: 'Provider-agnostic AI wrapper with API + RAG support'
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
