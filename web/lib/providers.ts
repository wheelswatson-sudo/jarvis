import Anthropic from '@anthropic-ai/sdk'
import OpenAI from 'openai'
import { GoogleGenerativeAI } from '@google/generative-ai'

export type Provider =
  | 'anthropic'
  | 'openai'
  | 'google'
  | 'groq'
  | 'mistral'

export type ChatMessage = { role: 'user' | 'assistant'; content: string }

export type ModelInfo = {
  id: string
  label: string
  provider: Provider
  /** Provider-specific model identifier sent to the API. */
  apiModel: string
}

export const MODELS: ModelInfo[] = [
  {
    id: 'claude-sonnet-4-6',
    label: 'Claude Sonnet 4.6',
    provider: 'anthropic',
    apiModel: 'claude-sonnet-4-6',
  },
  {
    id: 'claude-opus-4-6',
    label: 'Claude Opus 4.6',
    provider: 'anthropic',
    apiModel: 'claude-opus-4-6',
  },
  {
    id: 'gpt-4o',
    label: 'GPT-4o',
    provider: 'openai',
    apiModel: 'gpt-4o',
  },
  {
    id: 'gpt-4.1',
    label: 'GPT-4.1',
    provider: 'openai',
    apiModel: 'gpt-4.1',
  },
  {
    id: 'gemini-2.5-pro',
    label: 'Gemini 2.5 Pro',
    provider: 'google',
    apiModel: 'gemini-2.5-pro',
  },
  {
    id: 'groq-llama-4-maverick',
    label: 'Llama 4 Maverick (Groq)',
    provider: 'groq',
    apiModel: 'meta-llama/llama-4-maverick-17b-128e-instruct',
  },
  {
    id: 'mistral-large',
    label: 'Mistral Large',
    provider: 'mistral',
    apiModel: 'mistral-large-latest',
  },
]

export const DEFAULT_MODEL_ID = 'claude-sonnet-4-6'

export function getModel(id: string | null | undefined): ModelInfo {
  return MODELS.find((m) => m.id === id) ?? MODELS[0]!
}

export const PROVIDERS: Array<{ id: Provider; label: string }> = [
  { id: 'anthropic', label: 'Anthropic' },
  { id: 'openai', label: 'OpenAI' },
  { id: 'google', label: 'Google' },
  { id: 'groq', label: 'Groq' },
  { id: 'mistral', label: 'Mistral' },
]

export type StreamOptions = {
  apiKey: string
  model: ModelInfo
  system: string
  messages: ChatMessage[]
  maxTokens?: number
  signal?: AbortSignal
}

const DEFAULT_MAX_TOKENS = 1024

const OPENAI_COMPAT_BASE_URL: Partial<Record<Provider, string>> = {
  groq: 'https://api.groq.com/openai/v1',
  mistral: 'https://api.mistral.ai/v1',
}

export async function* streamCompletion(
  opts: StreamOptions,
): AsyncGenerator<string> {
  switch (opts.model.provider) {
    case 'anthropic':
      yield* streamAnthropic(opts)
      return
    case 'openai':
      yield* streamOpenAICompatible(opts, undefined)
      return
    case 'groq':
    case 'mistral':
      yield* streamOpenAICompatible(
        opts,
        OPENAI_COMPAT_BASE_URL[opts.model.provider],
      )
      return
    case 'google':
      yield* streamGoogle(opts)
      return
  }
}

async function* streamAnthropic(opts: StreamOptions): AsyncGenerator<string> {
  const client = new Anthropic({ apiKey: opts.apiKey })
  const stream = client.messages.stream({
    model: opts.model.apiModel,
    max_tokens: opts.maxTokens ?? DEFAULT_MAX_TOKENS,
    system: opts.system,
    messages: opts.messages,
  })
  if (opts.signal) {
    opts.signal.addEventListener('abort', () => stream.controller.abort(), {
      once: true,
    })
  }
  for await (const event of stream) {
    if (
      event.type === 'content_block_delta' &&
      event.delta.type === 'text_delta'
    ) {
      yield event.delta.text
    }
  }
}

async function* streamOpenAICompatible(
  opts: StreamOptions,
  baseURL: string | undefined,
): AsyncGenerator<string> {
  const client = new OpenAI({ apiKey: opts.apiKey, baseURL })
  const stream = await client.chat.completions.create(
    {
      model: opts.model.apiModel,
      max_tokens: opts.maxTokens ?? DEFAULT_MAX_TOKENS,
      stream: true,
      messages: [
        { role: 'system', content: opts.system },
        ...opts.messages.map((m) => ({ role: m.role, content: m.content })),
      ],
    },
    { signal: opts.signal },
  )
  for await (const chunk of stream) {
    const delta = chunk.choices[0]?.delta?.content
    if (typeof delta === 'string' && delta.length > 0) {
      yield delta
    }
  }
}

async function* streamGoogle(opts: StreamOptions): AsyncGenerator<string> {
  const client = new GoogleGenerativeAI(opts.apiKey)
  const model = client.getGenerativeModel({
    model: opts.model.apiModel,
    systemInstruction: opts.system,
    generationConfig: {
      maxOutputTokens: opts.maxTokens ?? DEFAULT_MAX_TOKENS,
    },
  })
  const history = opts.messages.slice(0, -1).map((m) => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }))
  const last = opts.messages[opts.messages.length - 1]!
  const chat = model.startChat({ history })
  const result = await chat.sendMessageStream(last.content)
  for await (const chunk of result.stream) {
    if (opts.signal?.aborted) break
    const text = chunk.text()
    if (text) yield text
  }
}
