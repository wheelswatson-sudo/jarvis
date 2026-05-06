'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  deleteApiKey,
  updatePreferredModel,
  upsertApiKey,
} from './actions'
import type { ModelInfo, Provider } from '../../lib/providers'

type ApiKeyRow = {
  provider: Provider
  masked: string
  is_active: boolean
  updated_at: string
}

type Props = {
  allModels: ModelInfo[]
  allProviders: Array<{ id: Provider; label: string }>
  preferredModel: string
  existingKeys: ApiKeyRow[]
}

export function SettingsClient({
  allModels,
  allProviders,
  preferredModel,
  existingKeys,
}: Props) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [model, setModel] = useState(preferredModel)
  const [modelStatus, setModelStatus] = useState<string | null>(null)
  const [keyStatus, setKeyStatus] = useState<Record<string, string | null>>({})

  const keysByProvider = new Map(existingKeys.map((k) => [k.provider, k]))

  function handleModelChange(next: string) {
    setModel(next)
    setModelStatus(null)
    startTransition(async () => {
      const res = await updatePreferredModel(next)
      if ('error' in res) {
        setModelStatus(`Error: ${res.error}`)
      } else {
        setModelStatus('Saved.')
        router.refresh()
      }
    })
  }

  function handleSaveKey(provider: Provider, value: string) {
    setKeyStatus((s) => ({ ...s, [provider]: null }))
    startTransition(async () => {
      const res = await upsertApiKey(provider, value)
      if ('error' in res) {
        setKeyStatus((s) => ({ ...s, [provider]: `Error: ${res.error}` }))
      } else {
        setKeyStatus((s) => ({ ...s, [provider]: 'Saved.' }))
        router.refresh()
      }
    })
  }

  function handleDeleteKey(provider: Provider) {
    setKeyStatus((s) => ({ ...s, [provider]: null }))
    startTransition(async () => {
      const res = await deleteApiKey(provider)
      if ('error' in res) {
        setKeyStatus((s) => ({ ...s, [provider]: `Error: ${res.error}` }))
      } else {
        setKeyStatus((s) => ({ ...s, [provider]: 'Removed.' }))
        router.refresh()
      }
    })
  }

  return (
    <div className="space-y-12">
      <Section
        title="Default model"
        subtitle="Used by every AIEA chat unless you override it later."
      >
        <div className="rounded-2xl aiea-glass p-5">
          <label className="block text-xs uppercase tracking-wide text-zinc-500">
            Model
          </label>
          <div className="relative mt-2">
            <select
              value={model}
              onChange={(e) => handleModelChange(e.target.value)}
              disabled={isPending}
              className="w-full appearance-none rounded-lg border border-zinc-800 bg-zinc-950 px-4 py-2.5 pr-10 text-sm text-zinc-100 outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/30 disabled:opacity-50"
            >
              {allModels.map((m) => (
                <option key={m.id} value={m.id} className="bg-zinc-900">
                  {m.label}
                </option>
              ))}
            </select>
            <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-zinc-500">
              ▾
            </span>
          </div>
          <p className="mt-2 text-xs text-zinc-500">
            Routed to{' '}
            <span className="font-medium text-zinc-300">
              {allModels.find((m) => m.id === model)?.provider ?? 'unknown'}
            </span>{' '}
            using your API key for that provider.
          </p>
          {modelStatus && (
            <p
              className={`mt-3 text-xs ${
                modelStatus.startsWith('Error') ? 'text-rose-400' : 'text-emerald-400'
              }`}
            >
              {modelStatus}
            </p>
          )}
        </div>
      </Section>

      <Section
        title="API keys"
        subtitle="One key per provider. Stored encrypted-at-rest in Supabase, only ever sent to that provider's API."
      >
        <div className="space-y-3">
          {allProviders.map((p) => {
            const existing = keysByProvider.get(p.id)
            return (
              <ProviderKeyRow
                key={p.id}
                provider={p}
                existing={existing}
                status={keyStatus[p.id] ?? null}
                disabled={isPending}
                onSave={(value) => handleSaveKey(p.id, value)}
                onDelete={() => handleDeleteKey(p.id)}
              />
            )
          })}
        </div>
      </Section>
    </div>
  )
}

function Section({
  title,
  subtitle,
  children,
}: {
  title: string
  subtitle: string
  children: React.ReactNode
}) {
  return (
    <section>
      <div className="mb-4">
        <h2 className="text-base font-medium text-zinc-100">{title}</h2>
        <p className="mt-1 text-sm text-zinc-500">{subtitle}</p>
      </div>
      {children}
    </section>
  )
}

function ProviderKeyRow({
  provider,
  existing,
  status,
  disabled,
  onSave,
  onDelete,
}: {
  provider: { id: Provider; label: string }
  existing: ApiKeyRow | undefined
  status: string | null
  disabled: boolean
  onSave: (value: string) => void
  onDelete: () => void
}) {
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState('')

  function submit() {
    if (!value.trim()) return
    onSave(value)
    setValue('')
    setEditing(false)
  }

  return (
    <div className="rounded-2xl aiea-glass p-5">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-zinc-100">
              {provider.label}
            </span>
            {existing ? (
              <span className="rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-[10px] uppercase tracking-wide text-emerald-300">
                Connected
              </span>
            ) : (
              <span className="rounded-full border border-zinc-700 bg-zinc-800/50 px-2 py-0.5 text-[10px] uppercase tracking-wide text-zinc-400">
                Not set
              </span>
            )}
          </div>
          {existing && !editing && (
            <p className="mt-1 font-mono text-xs text-zinc-500">
              {existing.masked}
            </p>
          )}
        </div>
        <div className="flex shrink-0 gap-2">
          {!editing && (
            <button
              type="button"
              onClick={() => setEditing(true)}
              disabled={disabled}
              className="rounded-md border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-xs text-zinc-300 hover:border-indigo-500 hover:text-indigo-300 disabled:opacity-50 transition-colors"
            >
              {existing ? 'Replace' : 'Add key'}
            </button>
          )}
          {existing && !editing && (
            <button
              type="button"
              onClick={onDelete}
              disabled={disabled}
              className="rounded-md border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-xs text-zinc-400 hover:border-rose-500 hover:text-rose-300 disabled:opacity-50 transition-colors"
            >
              Remove
            </button>
          )}
        </div>
      </div>
      {editing && (
        <div className="mt-4 flex gap-2">
          <input
            type="password"
            autoFocus
            placeholder={`${provider.label} API key`}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submit()
              if (e.key === 'Escape') {
                setEditing(false)
                setValue('')
              }
            }}
            className="flex-1 rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 font-mono text-xs text-zinc-100 outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/30"
          />
          <button
            type="button"
            onClick={submit}
            disabled={disabled || !value.trim()}
            className="rounded-lg bg-gradient-to-br from-indigo-500 to-violet-500 px-4 py-2 text-xs font-medium text-white shadow-sm shadow-indigo-500/30 hover:from-indigo-400 hover:to-violet-400 disabled:opacity-50 transition-all"
          >
            Save
          </button>
          <button
            type="button"
            onClick={() => {
              setEditing(false)
              setValue('')
            }}
            disabled={disabled}
            className="rounded-lg border border-zinc-800 px-3 py-2 text-xs text-zinc-400 hover:border-zinc-700 hover:text-zinc-200 disabled:opacity-50 transition-colors"
          >
            Cancel
          </button>
        </div>
      )}
      {status && (
        <p
          className={`mt-3 text-xs ${
            status.startsWith('Error') ? 'text-rose-400' : 'text-emerald-400'
          }`}
        >
          {status}
        </p>
      )}
    </div>
  )
}
