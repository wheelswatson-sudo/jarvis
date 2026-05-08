import type { Metadata, Viewport } from 'next'
import { Geist } from 'next/font/google'
import './globals.css'
import { ToastProvider } from '../components/Toast'

const geistSans = Geist({
  variable: '--font-geist-sans',
  subsets: ['latin'],
})

export const metadata: Metadata = {
  title: {
    default: 'AIEA — AI Executive Assistant',
    template: '%s · AIEA',
  },
  description:
    'AIEA is your AI executive assistant for relationship intelligence, commitments, and the daily briefing.',
}

export const viewport: Viewport = {
  themeColor: '#07070b',
  colorScheme: 'dark',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${geistSans.variable} h-full antialiased`}>
      <body className="min-h-full bg-[#07070b] text-zinc-100">
        <ToastProvider>{children}</ToastProvider>
      </body>
    </html>
  )
}
