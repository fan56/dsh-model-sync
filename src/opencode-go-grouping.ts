// P0 protocol grouping: official api-dictionary keys → route slots.
//
// Pure logic (07-design.md §6.2.3). P0 uses it for the diagnostic's protocol
// ownership column; P1 will reuse it for route planning. No settings/IO here.

import type { GoModelRecord } from './opencode-go-source.ts'

/** The four route slots of the go topology (design §6.2.2). */
export type GoRouteSlot = 'chat' | 'msg' | 'resp' | 'google'

export const GO_ROUTE_SLOTS: readonly GoRouteSlot[] = ['chat', 'msg', 'resp', 'google']

/** Default route id per slot (design §6.2.6). */
export const GO_SLOT_ROUTES: Readonly<Record<GoRouteSlot, string>> = {
  chat: 'opencode-go',
  msg: 'opencode-go-msg',
  resp: 'opencode-go-resp',
  google: 'opencode-go-google',
}

/** Official protocol names this plugin knows how to place. */
export const GO_KNOWN_PROTOCOLS: ReadonlySet<string> = new Set([
  'chat-completions',
  'messages',
  'responses',
  'interactions',
  'generate-content',
])

export interface GoUnassignedModel {
  id: string
  protocols: string[]
  reason: 'unsupported-protocol' | 'unknown-protocol'
}

export interface GoGroupingResult {
  slots: Record<GoRouteSlot, string[]>
  /** Models that must not be written anywhere, with the reason why. */
  unassigned: GoUnassignedModel[]
}

/** Map an official protocol key to a route slot. */
export function slotForProtocol(protocol: string): GoRouteSlot | undefined {
  switch (protocol) {
    case 'chat-completions': return 'chat'
    case 'messages': return 'msg'
    case 'responses': return 'resp'
    case 'interactions':
    case 'generate-content': return 'google'
    default: return undefined
  }
}

/**
 * Group official model ids by protocol (design §6.2.3):
 * - chat-completions present → chat (wins over any other protocol)
 * - exactly {messages} → msg; exactly {responses} → resp
 * - subset of {interactions, generate-content} → google
 * - multiple non-chat protocols → recommended_api breaks the tie
 * - empty / unknown / otherwise unsupported → unassigned (reported, never written)
 */
export function groupGoModelsByProtocol(entries: readonly GoModelRecord[]): GoGroupingResult {
  const slots: Record<GoRouteSlot, string[]> = { chat: [], msg: [], resp: [], google: [] }
  const unassigned: GoUnassignedModel[] = []

  for (const entry of entries) {
    const protocols = entry.protocols
    const unknown = protocols.filter((protocol) => !GO_KNOWN_PROTOCOLS.has(protocol))
    if (unknown.length > 0) {
      unassigned.push({ id: entry.id, protocols: [...protocols], reason: 'unknown-protocol' })
      continue
    }

    let slot: GoRouteSlot | undefined
    if (protocols.length === 0) {
      // no placement
    } else if (protocols.includes('chat-completions')) {
      slot = 'chat'
    } else if (protocols.length === 1 && protocols[0] === 'messages') {
      slot = 'msg'
    } else if (protocols.length === 1 && protocols[0] === 'responses') {
      slot = 'resp'
    } else if (protocols.every((p) => p === 'interactions' || p === 'generate-content')) {
      slot = 'google'
    } else if (protocols.length > 1 && entry.recommendedProtocol !== undefined) {
      slot = slotForProtocol(entry.recommendedProtocol)
    }

    if (slot === undefined) {
      unassigned.push({ id: entry.id, protocols: [...protocols], reason: 'unsupported-protocol' })
      continue
    }
    slots[slot].push(entry.id)
  }

  return { slots, unassigned }
}
