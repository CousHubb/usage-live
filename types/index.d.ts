/** One rate-limit window, as the last API response reported it. */
export type Limit = { kind: string; percentUsed: number; resetsAt?: string }

/** What the band draws: the latest figures the engine measured. */
export type Snapshot = {
  limits: Limit[]
  contextPercent?: number
  contextTokens?: number
}

/** The main conversation's cache entry, and the keep-alive pings sent for it. */
export type WarmState = {
  /** When the last main-loop request (or ping) read or wrote the cache. */
  lastRequestAt: number | null
  /** The model that answered it, for its prices. */
  model: string | null
  /** Pings sent since the last real request, and what they cost. */
  pings: number
  spentUsd: number
  /** Set when a ping missed the cache: no more pings this session. */
  isStopped: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'usage-live': {
      snapshot: Shaped<Snapshot | null>
      tick: number
      warm: Shaped<WarmState>
    }
  }
}
