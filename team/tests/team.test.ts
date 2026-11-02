import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

const R = 'id-team:recherche'
const E = 'id-team:entwuerfe'
const USAGE = { model: 'x', input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 9000, cache_creation_input_tokens: 500 }

// Stands for the engine beneath the mod and records what the mod asked of it.
function world(on: On) {
  const seen = {
    agents: [] as { name: string; model?: string; effort?: string | number; tools?: readonly string[] }[],
    spawnModels: [] as (string | undefined)[],
    efforts: [] as unknown[],
    submitted: [] as string[],
    statuses: [] as (string | undefined)[],
    toasts: [] as string[],
  }

  on('agent.register', (_, e) => {
    seen.agents.push(e)
    return { value: { agent: `team:${e.name}` } }
  })
  on('command.register', () => ({ value: { command: 'team' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('prompt.submit', (_, e) => {
    seen.submitted.push(e.text)
    return { text: e.text }
  })
  on('ui.status', (_, e) => {
    seen.statuses.push(e.text)
    return { value: undefined }
  })
  on('ui.toast', (_, e) => {
    seen.toasts.push(e.text)
    return { value: undefined }
  })
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.step', async function* (_, e) {
    seen.efforts.push(e.effort)
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn' as const, usage: null }
  })
  on('agent.spawn', (_, e) => {
    seen.spawnModels.push(e.model)
    return { model: e.model ?? 'inherit', agentId: `id-${e.subagentType}` }
  })
  on('tool.call', () => ({ result: 'ok' }))
  on('turn.complete', (_, e) => ({ text: e.answer }))

  return seen
}

async function start($: Engine) {
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
}

async function finish($: Engine, turnId: string, agentId?: string, isAborted = false) {
  await $.turn.complete({
    turnId,
    agentId,
    answer: 'fertig',
    durationMs: 1,
    isAborted,
    reason: isAborted ? 'aborted' : 'answer',
    usage: USAGE,
  })
}

async function step($: Engine, turnId: string, effort: 'low' | 'medium' | 'high' | 'max') {
  for await (const _ of $.turn.step({ turnId, index: 0, model: 'opus', effort, messageCount: 3 })) {
    // drained
  }
}

test('Recherche läuft sparsam auf Haiku, Entwürfe auf Sonnet', async ($, on) => {
  const seen = world(on)
  await start($)

  const recherche = seen.agents.find(agent => agent.name === 'recherche')
  const entwuerfe = seen.agents.find(agent => agent.name === 'entwuerfe')
  expect(recherche?.model).toBe('haiku')
  expect(recherche?.effort).toBe('low')
  expect(recherche?.tools).toEqual(['WebSearch', 'WebFetch'])
  expect(entwuerfe?.model).toBe('sonnet')
  expect(entwuerfe?.tools).not.toContain('WebSearch')
})

test('/team gibt dem Chef kurz danach einen Auftrag mit Plan und Regeln', async ($, on) => {
  const seen = world(on)
  const clock = mock.clock(on)
  await start($)

  const ran = await $.command.run({ command: 'team', args: 'Info für Jonas' })
  expect(seen.submitted.length).toBe(0)
  await clock.advance(100)

  expect(ran.text).toMatch(/Team gestartet/)
  expect(seen.submitted[0]).toMatch(/^\[Team-Chef\]/)
  expect(seen.submitted[0]).toMatch(/Info für Jonas/)
  expect(seen.submitted[0]).toMatch(/höchstens 4 konkrete Fragen/)
  expect(seen.submitted[0]).toMatch(/recherchierst nicht selbst/)
  expect(seen.submitted[0]).toMatch(/Nichts senden/)
})

test('/team ohne Aufgabe erklärt den Aufruf, /team stop ohne Lauf meldet das', async ($, on) => {
  const seen = world(on)
  await start($)

  expect((await $.command.run({ command: 'team', args: '' })).text).toMatch(/Aufruf: \/team/)
  expect((await $.command.run({ command: 'team', args: 'stop' })).text).toBe('Es läuft kein Team-Auftrag.')
  expect(seen.submitted.length).toBe(0)
})

test('fertig erst, wenn der Chef abgibt und kein Agent mehr läuft, mit Token-Bericht', async ($, on) => {
  const seen = world(on)
  await start($)

  // Chef's first turn starts the research and ends while it runs.
  await $.turn.start({ text: '[Team-Chef] Du bist der Chef …', turnId: 'c1' })
  await $.agent.spawn({ prompt: '1. Frage', subagentType: 'team:recherche' })
  await finish($, 'c1')
  expect(seen.toasts).toEqual([])

  await finish($, 'r1', R)
  // The research report wakes the chef, who hands on to the writer.
  await $.turn.start({ text: '', turnId: 'c2' })
  await $.agent.spawn({ prompt: 'Schreib', subagentType: 'team:entwuerfe' })
  await finish($, 'c2')
  expect(seen.toasts).toEqual([])

  await finish($, 'e1', E)
  await $.turn.start({ text: '', turnId: 'c3' })
  await finish($, 'c3')

  expect(seen.toasts).toEqual(['Team fertig · Chef 6k · Recherche 2k · Entwurf 2k Token'])
  expect(seen.statuses.at(-1)).toBeUndefined()
})

test('der Recherche-Agent wird nach seinem Budget gestoppt', async ($, on) => {
  world(on)
  await start($)
  await $.turn.start({ text: '[Team-Chef] …', turnId: 'c1' })
  await $.agent.spawn({ prompt: '1. Frage', subagentType: 'team:recherche' })

  const searches = []
  for (let i = 0; i < 5; i++) {
    searches.push(await $.tool.call({ tool: 'WebSearch', query: `q${i}`, agentId: R }))
  }

  expect(searches.slice(0, 4).every(one => JSON.stringify(one).includes('ok'))).toBe(true)
  expect(JSON.stringify(searches[4])).toMatch(/Budget erschöpft/)
})

test('der Chef darf während des Laufs nicht selbst suchen, sonst schon', async ($, on) => {
  world(on)
  await start($)

  expect(JSON.stringify(await $.tool.call({ tool: 'WebSearch', query: 'vorher' }))).toMatch(/ok/)
  await $.turn.start({ text: '[Team-Chef] …', turnId: 'c1' })
  expect(JSON.stringify(await $.tool.call({ tool: 'WebSearch', query: 'selbst' }))).toMatch(/Delegiere die Frage/)
})

test('Team-Agenten laufen immer auf ihrem Modell, auch wenn der Chef ein teureres verlangt', async ($, on) => {
  const seen = world(on)
  await start($)

  await $.agent.spawn({ prompt: 'x', subagentType: 'team:recherche', model: 'opus' })
  await $.agent.spawn({ prompt: 'y', subagentType: 'Explore', model: 'opus' })

  expect(seen.spawnModels).toEqual(['haiku', 'opus'])
})

test('der Chef denkt während des Laufs höchstens mit mittlerem Aufwand', async ($, on) => {
  const seen = world(on)
  await start($)

  await step($, 't0', 'high')
  await $.turn.start({ text: '[Team-Chef] …', turnId: 'c1' })
  await step($, 'c1', 'max')
  await step($, 'c1', 'low')

  expect(seen.efforts).toEqual(['high', 'medium', 'low'])
})

test('ein gestoppter Agent beendet den Lauf und räumt die Statuszeile auf', async ($, on) => {
  const seen = world(on)
  await start($)

  await $.turn.start({ text: '[Team-Chef] …', turnId: 'c1' })
  await $.agent.spawn({ prompt: '1. Frage', subagentType: 'team:recherche' })
  await finish($, 'c1')
  await finish($, 'r1', R, true)

  expect(seen.toasts[0]).toMatch(/^Team gestoppt/)
  expect(seen.statuses.at(-1)).toBeUndefined()
  expect((await $.command.run({ command: 'team', args: 'stop' })).text).toBe('Es läuft kein Team-Auftrag.')
})
