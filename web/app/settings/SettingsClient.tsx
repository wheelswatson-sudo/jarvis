'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  deleteApiKey,
  updatePreferredModel,
  upsertApiKey,
} from './actions'
import type { ModelInfo, Provider } from '../../lib/providers'
import { useToast } from '../../components/Toast'

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
  const toast = useToast()
  const [isPending, startTransition] = useTransition()
  const [model, setModel] = useState(preferredModel)

  const keysByProvider = new Map(existingKeys.map((k) => [k.provider, k]))

  function handleModelChange(next: string) {
    const prev = model
    setModel(next)
    startTransition(async () => {
      const res = await updatePreferredModel(next)
      if ('error' in res) {
        setModel(prev)
        toast.error(`Couldn't save model — ${res.error}`)
      } else {
        const label = allModels.find((m) => m.id === next)?.label ?? next
        toast.success(`Model set to ${label}`)
        router.refresh()
      }
    })
  }

  function handleSaveKey(provider: Provider, value: string) {
    startTransition(async () => {
      const res = await upsertApiKey(provider, value)
      if ('error' in res) {
        toast.error(`Couldn't save ${provider} key — ${res.error}`)
      } else {
        const label = allProviders.find((p) => p.id === provider)?.label ?? provider
        toast.success(`${label} key saved`)
        router.refresh()
      }
    })
  }

  function handleDeleteKey(provider: Provider) {
    startTransition(async () => {
      const res = await deleteApiKey(provider)
      if ('error' in res) {
        toast.error(`Couldn't remove ${provider} key — ${res.error}`)
      } else {
        const label = allProviders.find((p) => p.id === provider)?.label ?? provider
        toast.info(`${label} key removed`)
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
          <label className="block text-[10px] font-medium uppercase tracking-[0.16em] text-zinc-500">
            Model
          </label>
          <div className="relative mt-2">
            <select
              value={model}
              onChange={(e) => handleModelChange(e.target.value)}
              disabled={isPending}
              className="w-full appearance-none rounded-lg border border-white/[0.08] bg-white/[0.02] px-4 py-2.5 pr-10 text-sm text-zinc-100 outline-none transition-colors focus:border-violet-500/50 disabled:opacity-50"
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
      <div className="mb-5">
        <h2 className="text-lg font-medium tracking-tight text-zinc-100">{title}</h2>
        <p className="mt-1 max-w-xl text-sm text-zinc-400">{subtitle}</p>
      </div>
      {children}
    </section>
  )
}

function ProviderKeyRow({
  provider,
  existing,
  disabled,
  onSave,
  onDelete,
}: {
  provider: { id: Provider; label: string }
  existing: ApiKeyRow | undefined
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
    <div className="rounded-2xl aiea-glass p-5 transition-colors hover:border-white/[0.10]">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-zinc-100">
              {provider.label}
            </span>
            {existing ? (
              <span className="rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-emerald-300">
                Connected
              </span>
            ) : (
              <span className="rounded-full border border-white/[0.08] bg-white/[0.02] px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-zinc-500">
                Not set
              </span>
            )}
          </div>
          {existing && !editing && (
            <p className="mt-1.5 font-mono text-xs text-zinc-500">
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
              className="rounded-lg border border-white/[0.08] bg-white/[0.02] px-3 py-1.5 text-xs font-medium text-zinc-300 transition-colors hover:border-violet-400/40 hover:text-white disabled:opacity-50"
            >
              {existing ? 'Replace' : 'Add key'}
            </button>
          )}
          {existing && !editing && (
            <button
              type="button"
              onClick={onDelete}
              disabled={disabled}
              className="rounded-lg border border-white/[0.08] bg-white/[0.02] px-3 py-1.5 text-xs font-medium text-zinc-400 transition-colors hover:border-rose-500/50 hover:text-rose-300 disabled:opacity-50"
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
            className="flex-1 rounded-lg border border-white/[0.08] bg-white/[0.02] px-3 py-2 font-mono text-xs text-zinc-100 outline-none transition-colors focus:border-violet-500/50"
          />
          <button
            type="button"
            onClick={submit}
            disabled={disabled || !value.trim()}
            className="rounded-lg aiea-cta px-4 py-2 text-xs font-medium text-white disabled:opacity-50"
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
            className="rounded-lg border border-white/[0.08] bg-white/[0.02] px-3 py-2 text-xs text-zinc-400 transition-colors hover:border-white/[0.18] hover:text-zinc-200 disabled:opacity-50"
          >
            Cancel
          </button>
        </div>
      )}
    </div>
  )
}
