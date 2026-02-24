import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import '@fontsource-variable/inter';
import '@fontsource/jetbrains-mono/400.css';
import './globals.css';

export const metadata: Metadata = {
  title: 'Witness List — build a claim, prove it, try to cheat',
  description:
    'A zero-knowledge proof workshop. Build a claim as a circuit, run a real PLONK+FRI proof with every polynomial inspectable, then tamper with the witness and see exactly which equation catches you.',
  icons: {
    icon: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Ccircle cx='16' cy='16' r='11' stroke='%236d4ae0' stroke-width='2.5' fill='none'/%3E%3Ccircle cx='16' cy='16' r='4' fill='%236d4ae0'/%3E%3C/svg%3E",
  },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
