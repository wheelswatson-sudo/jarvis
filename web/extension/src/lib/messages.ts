import type {
  ContactMatch,
  ExtractedProfile,
  Settings,
  SidebarContext,
  StaleContact,
} from './types'

export type RpcOk<T> = { ok: true; data: T }
export type RpcErr = { ok: false; error: string; status?: number }
export type RpcResult<T> = RpcOk<T> | RpcErr

export type RpcMap = {
  'get-settings': { req: object; res: Settings }
  'set-settings': { req: { settings: Settings }; res: Settings }
  ping: { req: object; res: { ok: true; user: string } }
  match: {
    req: { url: string; name: string | null }
    res: { match: ContactMatch | null }
  }
  context: { req: { contactId: string }; res: SidebarContext }
  'social-update': {
    req: { contactId: string; profile: ExtractedProfile }
    res: { updated: true }
  }
  'stale-list': { req: object; res: { contacts: StaleContact[] } }
  search: { req: { query: string }; res: { contacts: ContactMatch[] } }
}

export type RpcKind = keyof RpcMap

export type RpcRequest = {
  [K in RpcKind]: { kind: K } & RpcMap[K]['req']
}[RpcKind]

export type RpcResponse = {
  [K in RpcKind]: { kind: K; result: RpcResult<RpcMap[K]['res']> }
}[RpcKind]

async function rpcRaw(request: RpcRequest): Promise<RpcResult<unknown>> {
  const response = (await chrome.runtime.sendMessage(request)) as
    | { result: RpcResult<unknown> }
    | undefined
  if (!response) {
    return { ok: false, error: 'No response from background' }
  }
  return response.result
}

export async function rpc<K extends RpcKind>(
  request: { kind: K } & RpcMap[K]['req'],
): Promise<RpcResult<RpcMap[K]['res']>> {
  const result = await rpcRaw(request as RpcRequest)
  return result as RpcResult<RpcMap[K]['res']>
}
