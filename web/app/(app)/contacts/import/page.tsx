import Link from 'next/link'
import { PageHeader } from '../../../../components/cards'
import { ImportClient } from './ImportClient'

export const dynamic = 'force-dynamic'

export const metadata = {
  title: 'Import contacts',
}

export default function ContactImportPage() {
  return (
    <div className="space-y-8 animate-fade-up">
      <Link
        href="/contacts"
        className="inline-flex items-center gap-1 text-xs text-zinc-500 transition-colors hover:text-zinc-200"
      >
        <span aria-hidden="true">←</span> Back to contacts
      </Link>

      <PageHeader
        eyebrow="Onboarding"
        title="Import contacts"
        subtitle="Drop in a CSV from LinkedIn, your CRM, or a spreadsheet — or add a single contact by hand. We'll auto-map common columns and show you a preview before anything is saved."
      />

      <ImportClient />
    </div>
  )
}
