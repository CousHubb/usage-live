import { atom, read, update } from 'claude-code'
import type { Register, SessionContextUsage, SessionRateLimit } from 'claude-code'

import type { Limit, Snapshot, WarmState } from '../types'

const COMMAND = 'usage-live'
// The pane earlier versions opened: closed at start, the band replaced it.
const OLD_PANE = 'usage-live'

// Change a tag when its type's fields change: it declines what an earlier
// version stored, which outlives a reload.
const snapshot = atom({ plugin: 'usage-live', key: 'snapshot' } as const, null, {
  shape: 'snapshot-2',
})
// Bumped every minute so the countdowns redraw.
const tick = atom({ plugin: 'usage-live', key: 'tick' } as const, 0)
const NO_WARM: WarmState = {
  lastRequestAt: null,
  model: null,
  pings: 0,
  spentUsd: 0,
  isStopped: false,
}
const warm = atom({ plugin: 'usage-live', key: 'warm' } as const, NO_WARM, {
  shape: 'warm-1',
})
// Across sessions: whether the person let the band keep the cache warm.
const KEEP_WARM_KEY = 'keepWarm'

// ---------------------------------------------------------------- wording

const LABELS: Record<string, { short: string; rank: number }> = {
  five_hour: { short: '5 h', rank: 0 },
  seven_day: { short: '7 j', rank: 1 },
  seven_day_opus: { short: '7 j Opus', rank: 2 },
  seven_day_sonnet: { short: '7 j Sonnet', rank: 3 },
  spend_limit: { short: 'Plafond', rank: 4 },
}

const labelOf = (kind: string) => LABELS[kind] ?? { short: kind.replace(/_/g, ' '), rank: 9 }

const fmtPct = (p: number) => `${String(Math.round(p * 10) / 10).replace('.', ',')} %`

const clamp = (n: number, lo: number, hi: number) => Math.min(Math.max(n, lo), hi)

// "1 h 57", "1 j 4 h", "20 min" until the ISO time; undefined when unknown.
const spanUntil = (iso: string | undefined, now: number): string | undefined => {
  if (iso === undefined) return undefined
  const at = Date.parse(iso)
  if (!Number.isFinite(at)) return undefined
  const mins = Math.max(0, Math.round((at - now) / 60_000))
  if (mins === 0) return 'un instant'
  const d = Math.floor(mins / 1440)
  const h = Math.floor((mins % 1440) / 60)
  const m = mins % 60

  return d > 0 ? `${d} j ${h} h` : h > 0 ? `${h} h ${String(m).padStart(2, '0')}` : `${m} min`
}

// ---------------------------------------------------------------- prices

// $ per million tokens: input, output, cache read (claude-api skill's table,
// 2026-11). A cache write costs 1.25x input for 5 minutes, 2x for 1 hour.
// Most specific id first: 'claude-opus-5' also matches 'claude-opus-5-5'.
type Price = { input: number; output: number; read: number }
const PRICES: [string, Price][] = [
  ['claude-fable-5-2', { input: 8, output: 40, read: 0.2 }],
  ['claude-mythos-5-2', { input: 8, output: 40, read: 0.2 }],
  ['claude-fable-5-1', { input: 10, output: 50, read: 0.25 }],
  ['claude-mythos-5-1', { input: 10, output: 50, read: 0.25 }],
  ['claude-fable-5', { input: 10, output: 50, read: 1 }],
  ['claude-mythos-5', { input: 10, output: 50, read: 1 }],
  ['claude-opus-5-5', { input: 4, output: 20, read: 0.2 }],
  ['claude-opus-5', { input: 5, output: 25, read: 0.5 }],
  ['claude-opus-4', { input: 5, output: 25, read: 0.5 }],
  ['claude-sonnet-5-5', { input: 2, output: 10, read: 0.1 }],
  ['claude-sonnet-5', { input: 2, output: 10, read: 0.2 }],
  ['claude-sonnet-4', { input: 3, output: 15, read: 0.3 }],
  ['claude-haiku-5-5', { input: 0.1, output: 0.5, read: 0.01 }],
  ['claude-haiku-4', { input: 1, output: 5, read: 0.1 }],
]
const MTOK = 1_000_000

const priceOf = (model: string | null): Price | undefined =>
  model === null ? undefined : PRICES.find(([id]) => model.includes(id))?.[1]

// Claude Code caches for an hour on a subscription, five minutes otherwise.
const ttlMs = (isSubscription: boolean) => (isSubscription ? 60 : 5) * 60_000
const writeMult = (isSubscription: boolean) => (isSubscription ? 2 : 1.25)

// The keep-alive: from 55 minutes after the last request, past 50k tokens.
const WARM_AFTER_MS = 55 * 60_000
const WARM_MIN_TOKENS = 50_000
const PING_OUTPUT_TOKENS = 300
const PING_PROMPT =
  'Keep-alive ping sent by a plugin to refresh the prompt cache. ' +
  'Reply with the single word "ok". Do not think it over and do not use tools.'

type CacheState = { isHot: boolean; minutesLeft: number }

const cacheStateOf = (w: WarmState, isSubscription: boolean, now: number) => {
  if (w.lastRequestAt === null) return undefined
  const left = w.lastRequestAt + ttlMs(isSubscription) - now
  const state: CacheState =
    left > 0
      ? { isHot: true, minutesLeft: Math.ceil(left / 60_000) }
      : { isHot: false, minutesLeft: 0 }

  return state
}

// What the next message costs to read the conversation: a cache read while
// hot, a fresh cache write once it has cooled.
const nextMessageUsd = (tokens: number, p: Price, isHot: boolean, isSubscription: boolean) =>
  (tokens * (isHot ? p.read : p.input * writeMult(isSubscription))) / MTOK

const usageUsd = (
  u: {
    input_tokens: number
    output_tokens: number
    cache_read_input_tokens: number
    cache_creation_input_tokens: number
  },
  p: Price,
  isSubscription: boolean,
) =>
  (u.input_tokens * p.input +
    u.output_tokens * p.output +
    u.cache_read_input_tokens * p.read +
    u.cache_creation_input_tokens * p.input * writeMult(isSubscription)) /
  MTOK

const fmtCost = (usd: number) =>
  usd < 0.005 ? '< 0,01 $' : `≈ ${usd.toFixed(2).replace('.', ',')} $`

// ---------------------------------------------------------------- figures

const toSnapshot = (u: {
  context: SessionContextUsage
  rateLimits: SessionRateLimit[]
}): Snapshot => {
  const limits: Limit[] = u.rateLimits
    .map(l => ({ kind: l.kind, percentUsed: l.percentUsed, resetsAt: l.resetsAt }))
    .sort((a, b) => labelOf(a.kind).rank - labelOf(b.kind).rank)

  return { limits, contextPercent: u.context.percent, contextTokens: u.context.tokens }
}

// ---------------------------------------------------------------- hooks

export const register: Register = on => {
  // A main-loop turn in flight, or a ping: never ping over either.
  let isBusy = false
  let isWarming = false

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({
      name: COMMAND,
      description: 'Relance du cache de la bande Usage : « relance on » ou « relance off »',
    })

    const snap = toSnapshot(await $.session.usage())
    await update($, snapshot, () => snap)
    // The band above the prompt replaced the status line and the pane of
    // earlier versions: clear one, close the other if it is still open.
    $.ui.status(undefined)
    void $.ui.close({ id: OLD_PANE }).catch(() => undefined)

    // On a subscription, past 50k tokens, 55 minutes after the last request:
    // one cheap cache read keeps the hour-long entry alive, as long as the
    // pings since that request cost less than writing the cache again would.
    const keepWarm = async () => {
      if (isBusy || isWarming) return
      if ((await $.store.get(KEEP_WARM_KEY)) === false) return
      const w = await read($, warm)
      const s = await read($, snapshot)
      const p = priceOf(w.model)
      if (w.isStopped || w.lastRequestAt === null || s === null || p === undefined) return
      const tokens = s.contextTokens ?? 0
      if (s.limits.length === 0 || tokens <= WARM_MIN_TOKENS) return
      const now = await $.clock.now()
      const age = now - w.lastRequestAt
      if (age < WARM_AFTER_MS || age >= ttlMs(true)) return
      const pingUsd = (tokens * p.read + PING_OUTPUT_TOKENS * p.output) / MTOK
      const coolUsd = (tokens * (p.input * writeMult(true) - p.read)) / MTOK
      if (w.spentUsd + pingUsd >= coolUsd) return

      isWarming = true
      try {
        const r = await $.model.fork({ prompt: PING_PROMPT })
        const u = 'usage' in r ? r.usage : undefined
        const total =
          u === undefined
            ? 0
            : u.cache_read_input_tokens + u.cache_creation_input_tokens + u.input_tokens
        const served = u?.cache_read_input_tokens ?? 0
        const isHit = total > 0 && served >= total * 0.8
        const isMiss = total > 0 && !isHit
        await update($, warm, v => ({
          ...v,
          lastRequestAt: isHit ? now : v.lastRequestAt,
          pings: v.pings + (isHit ? 1 : 0),
          spentUsd: v.spentUsd + (u === undefined ? 0 : usageUsd(u, p, true)),
          isStopped: v.isStopped || isMiss,
        }))
        if (isMiss) {
          $.ui.toast('Relance du cache arrêtée : il avait déjà refroidi.')
        }
      } finally {
        isWarming = false
      }
    }

    $.clock.every(60_000, () => {
      void update($, tick, n => n + 1)
      void keepWarm().catch(() => undefined)
    })

    return started
  })

  on('command.run', { command: COMMAND }, async ($, e) => {
    const [word, value] = e.args.trim().toLowerCase().split(/\s+/)
    if (word === 'relance' && (value === 'on' || value === 'off')) {
      await $.store.set(KEEP_WARM_KEY, value === 'on')

      return {
        text: value === 'on' ? 'Relance du cache activée.' : 'Relance du cache désactivée.',
      }
    }
    const isOn = (await $.store.get(KEEP_WARM_KEY)) !== false

    return {
      text: `Relance du cache : ${isOn ? 'activée' : 'désactivée'}. Usage : /usage-live relance on|off`,
    }
  })

  // Pushed by the engine after each turn and whenever a limit moves a point.
  on('session.measure', async ($, e, next) => {
    const snap = toSnapshot(e)
    await update($, snapshot, () => snap)

    return next(e)
  })

  on('turn.start', ($, e, next) => {
    if (e.agentId === undefined) isBusy = true

    return next(e)
  })

  // A main-loop turn restarts the cache's clock and the ping budget.
  on('turn.complete', async ($, e, next) => {
    const u = e.usage
    if (e.agentId === undefined) {
      isBusy = false
      if (u !== undefined) {
        const now = await $.clock.now()
        await update($, warm, w => ({
          ...w,
          lastRequestAt: now,
          model: u.model,
          pings: 0,
          spentUsd: 0,
        }))
      }
    }

    return next(e)
  })

  // The band above the prompt: the plan's limits on one line, this
  // conversation (context, cache, next message) on the next.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const snap = await read($, snapshot)
    const w = await read($, warm)
    await read($, tick)

    if (
      e.props.hasSurvey ||
      snap === null ||
      (snap.limits.length === 0 && snap.contextPercent === undefined)
    ) {
      return next(e)
    }

    const { Box, Text } = $.ui.resolve(e)
    const now = await $.clock.now()
    const isSubscription = snap.limits.length > 0
    const state = cacheStateOf(w, isSubscription, now)
    const price = priceOf(w.model)
    const tokens = snap.contextTokens
    const nextUsd =
      state !== undefined && price !== undefined && tokens !== undefined
        ? nextMessageUsd(tokens, price, state.isHot, isSubscription)
        : undefined
    const BAR = 8

    return (
      <Box flexDirection="column">
        {snap.limits.length > 0 && (
          <Box flexDirection="row" flexWrap="wrap" columnGap={3}>
            {snap.limits.map(l => {
              const filled = Math.round((BAR * clamp(l.percentUsed, 0, 100)) / 100)
              const span = spanUntil(l.resetsAt, now)

              return (
                <Text>
                  <Text dimColor>{labelOf(l.kind).short} </Text>
                  {filled > 0 ? <Text>{'█'.repeat(filled)}</Text> : null}
                  {filled < BAR ? <Text dimColor>{'█'.repeat(BAR - filled)}</Text> : null}
                  <Text bold> {fmtPct(l.percentUsed)}</Text>
                  {span !== undefined ? <Text dimColor> · reset dans {span}</Text> : null}
                </Text>
              )
            })}
          </Box>
        )}
        <Box flexDirection="row" flexWrap="wrap" columnGap={3}>
          {snap.contextPercent !== undefined ? (
            <Text>
              <Text dimColor>Contexte </Text>
              <Text bold>{fmtPct(snap.contextPercent)}</Text>
            </Text>
          ) : null}
          {state !== undefined ? (
            <Text>
              <Text dimColor>Cache </Text>
              {state.isHot ? (
                <Text color="warning" bold>
                  CHAUD
                </Text>
              ) : (
                <Text color="suggestion" bold>
                  FROID
                </Text>
              )}
              {state.isHot ? <Text bold> {state.minutesLeft} min</Text> : null}
              {w.pings > 0 ? <Text dimColor> · relancé {w.pings}×</Text> : null}
            </Text>
          ) : null}
          {nextUsd !== undefined ? (
            <Text>
              <Text dimColor>Prochain message </Text>
              <Text bold>{fmtCost(nextUsd)}</Text>
            </Text>
          ) : null}
        </Box>
      </Box>
    )
  })
}
