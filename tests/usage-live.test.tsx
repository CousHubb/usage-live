import type { ModelForkResult, On, SessionUsage } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

const NOW = Date.parse('2026-11-16T10:00:00Z')
const MIN = 60_000

const USAGE: SessionUsage = {
  startedAt: NOW,
  context: { tokens: 90_000, window: 200_000, percent: 45 },
  rateLimits: [
    { kind: 'seven_day', percentUsed: 41, resetsAt: '2026-11-19T14:00:00Z' },
    { kind: 'five_hour', percentUsed: 23.5, resetsAt: '2026-11-16T12:13:00Z' },
  ],
  cost: { usd: 1.234 },
}

const turnEnd = (read: number, write: number, uncached: number, agentId?: string) => ({
  answer: 'ok',
  durationMs: 1000,
  isAborted: false,
  turnId: `t-${read}-${write}`,
  reason: 'answer' as const,
  ...(agentId === undefined ? {} : { agentId }),
  usage: {
    input_tokens: uncached,
    output_tokens: 500,
    cache_read_input_tokens: read,
    cache_creation_input_tokens: write,
    model: 'claude-opus-5-5',
  },
})

const engine = (
  on: On,
  usage: SessionUsage = USAGE,
  store: Readonly<Record<string, unknown>> = {},
  closed: string[] = [],
) => {
  const clock = mock.clock(on, { now: NOW })
  mock.store(on, store)
  on('command.register', () => ({ value: { command: 'usage-live' } }))
  on('ui.close', (_, e) => {
    closed.push(e.id)

    return { value: undefined }
  })
  on('session.usage', () => ({ value: usage }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.measure', (_, e) => ({ changed: e.changed }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))

  return clock
}

const BAND = {
  plugin: 'usage-live',
  component: 'AbovePrompt',
  requestId: 'band',
  props: {
    hasSurvey: false,
    isCollapsed: false,
    isWorking: false,
    maxRows: 12,
    bodyColumns: 100,
    scroll: { offset: 0, bodyRows: 12 },
    view: {},
  },
} as const

test('the session start closes the pane of earlier versions', async ($, on) => {
  const closed: string[] = []
  engine(on, USAGE, {}, closed)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  expect(closed).toEqual(['usage-live'])
})

test('before any reading the band leaves its row to the engine', async ($, on) => {
  engine(on, { startedAt: NOW, context: { window: 200_000 }, rateLimits: [] })
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text>engine</Text>
  })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })

  expect((await ui.find({ type: 'Text' }))?.text).toBe('engine')
  await ui.unmount()
})

test('a new measurement redraws the band', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })

  await $.session.measure({
    ...USAGE,
    rateLimits: [{ kind: 'five_hour', percentUsed: 87, resetsAt: '2026-11-16T10:20:00Z' }],
    changed: ['rateLimits'],
  })

  expect((await ui.find({ type: 'Text', text: /^5 h/ }))?.text).toBe(
    '5 h ████████ 87 % · reset dans 20 min',
  )
  await ui.unmount()
})

// ------------------------------------------------------------ the band

test('the band shows the limits, the context, a hot cache and the next message', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.turn.complete(turnEnd(180_000, 12_000, 8_000))

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })

    expect((await ui.find({ type: 'Text', text: /^5 h/ }))?.text).toBe(
      '5 h ████████ 23,5 % · reset dans 2 h 13',
    )
    expect((await ui.find({ type: 'Text', text: /^7 j/ }))?.text).toBe(
      '7 j ████████ 41 % · reset dans 3 j 4 h',
    )
    expect((await ui.find({ type: 'Text', text: /^Contexte/ }))?.text).toBe('Contexte 45 %')
    expect((await ui.find({ type: 'Text', text: /^Cache/ }))?.text).toBe('Cache CHAUD 60 min')
    // Hot on Opus 5.5: 90k tokens read at $0.20/MTok.
    expect((await ui.find({ type: 'Text', text: /^Prochain/ }))?.text).toBe(
      'Prochain message ≈ 0,02 $',
    )
    await ui.unmount()
  }
})

test('after an hour the cache is cold and the next message costs a fresh write', async ($, on) => {
  const clock = engine(on, USAGE, { keepWarm: false })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.turn.complete(turnEnd(180_000, 12_000, 8_000))
  await clock.advance(61 * MIN)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })

  expect((await ui.find({ type: 'Text', text: /^Cache/ }))?.text).toBe('Cache FROID')
  // Cold on Opus 5.5: 90k tokens written for an hour at 2 x $4/MTok.
  expect((await ui.find({ type: 'Text', text: /^Prochain/ }))?.text).toBe(
    'Prochain message ≈ 0,72 $',
  )
  await ui.unmount()
})

const FORK_HIT: ModelForkResult & { isAnswered: true } = {
  isAnswered: true,
  text: 'ok',
  usage: {
    input_tokens: 30,
    output_tokens: 5,
    cache_read_input_tokens: 90_000,
    cache_creation_input_tokens: 0,
  },
}

test('the cache is pinged 55 minutes after the last request, and stays hot', async ($, on) => {
  const clock = engine(on)
  let forks = 0
  on('model.fork', () => {
    forks += 1

    return { value: FORK_HIT }
  })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.turn.complete(turnEnd(180_000, 12_000, 8_000))

  await clock.advance(54 * MIN)
  expect(forks).toBe(0)
  await clock.advance(1 * MIN)
  expect(forks).toBe(1)

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /^Cache/ }))?.text).toBe(
    'Cache CHAUD 60 min · relancé 1×',
  )
  await ui.unmount()

  await clock.advance(55 * MIN)
  expect(forks).toBe(2)
})

test('pings stop once they would cost more than letting the cache cool', async ($, on) => {
  const clock = engine(on)
  let forks = 0
  on('model.fork', () => {
    forks += 1

    return { value: FORK_HIT }
  })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.turn.complete(turnEnd(180_000, 12_000, 8_000))

  // Cooling costs 90k x ($8 - $0.20)/MTok = $0.702. Each ping here costs
  // $0.0182 (90k read, 30 in, 5 out) and the next one is budgeted at $0.024:
  // the 38th brings the spend to $0.692, and a 39th would pass $0.702.
  for (let i = 0; i < 40; i += 1) await clock.advance(55 * MIN)
  expect(forks).toBe(38)
})

test('no ping under 50k tokens', async ($, on) => {
  let forks = 0
  const small: SessionUsage = { ...USAGE, context: { tokens: 30_000, window: 200_000, percent: 15 } }
  const clock = engine(on, small)
  on('model.fork', () => {
    forks += 1

    return { value: FORK_HIT }
  })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.turn.complete(turnEnd(180_000, 12_000, 8_000))
  await clock.advance(56 * MIN)
  expect(forks).toBe(0)
})

test('a ping that finds the cache cold stops the pings', async ($, on) => {
  const clock = engine(on)
  let forks = 0
  on('model.fork', () => {
    forks += 1

    const miss: ModelForkResult = {
      ...FORK_HIT,
      usage: { ...FORK_HIT.usage, cache_read_input_tokens: 0, cache_creation_input_tokens: 90_000 },
    }

    return { value: miss }
  })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.turn.complete(turnEnd(180_000, 12_000, 8_000))
  await clock.advance(55 * MIN)
  expect(forks).toBe(1)
  await clock.advance(4 * MIN)
  expect(forks).toBe(1)
})
