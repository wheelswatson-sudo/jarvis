'use server'

import { revalidatePath } from 'next/cache'
import { createClient } from '../../lib/supabase/server'
import { MODELS, PROVIDERS, type Provider } from '../../lib/providers'

const VALID_MODEL_IDS = new Set(MODELS.map((m) => m.id))
const VALID_PROVIDERS = new Set<Provider>(PROVIDERS.map((p) => p.id))

function isValidProvider(p: string): p is Provider {
  return VALID_PROVIDERS.has(p as Provider)
}

export async function updatePreferredModel(
  modelId: string,
): Promise<{ ok: true } | { error: string }> {
  if (!VALID_MODEL_IDS.has(modelId)) return { error: 'Unknown model' }

  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { error: 'Unauthorized' }

  const { error } = await supabase
    .from('profiles')
    .upsert(
      { id: user.id, preferred_model: modelId },
      { onConflict: 'id' },
    )
  if (error) return { error: error.message }

  revalidatePath('/settings')
  return { ok: true }
}

export async function upsertApiKey(
  provider: string,
  apiKey: string,
): Promise<{ ok: true } | { error: string }> {
  if (!isValidProvider(provider)) return { error: 'Unknown provider' }
  const trimmed = apiKey.trim()
  if (!trimmed) return { error: 'API key cannot be empty' }

  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { error: 'Unauthorized' }

  const { error } = await supabase
    .from('user_api_keys')
    .upsert(
      {
        user_id: user.id,
        provider,
        api_key: trimmed,
        is_active: true,
      },
      { onConflict: 'user_id,provider' },
    )
  if (error) return { error: error.message }

  revalidatePath('/settings')
  return { ok: true }
}

export async function deleteApiKey(
  provider: string,
): Promise<{ ok: true } | { error: string }> {
  if (!isValidProvider(provider)) return { error: 'Unknown provider' }

  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { error: 'Unauthorized' }

  const { error } = await supabase
    .from('user_api_keys')
    .delete()
    .eq('user_id', user.id)
    .eq('provider', provider)
  if (error) return { error: error.message }

  revalidatePath('/settings')
  return { ok: true }
}
