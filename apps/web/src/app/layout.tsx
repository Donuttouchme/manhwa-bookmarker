import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Manhwa Bookmarker',
  description: 'Track unread chapters across manga/manhwa sites.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  );
}
