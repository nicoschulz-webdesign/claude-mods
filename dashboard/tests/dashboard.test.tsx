import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

const PANE = {
  plugin: 'dashboard',
  component: 'Pane',
  requestId: 'dashboard',
  props: {
    title: 'Dashboard',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

const LENA = { id: 'g1', quelle: 'Gmail', von: 'Lena', betreff: 'Termin', text: 'Passt dir Dienstag?' }
const MAX = { id: 's1', quelle: 'Slack', von: 'Max', text: 'Wie viel kostet das?' }

// Stands for the engine beneath the mod and records what reached the prompt box.
function world(on: On, stored: Record<string, unknown> = {}) {
  const seen = { filled: [] as string[], submitted: [] as string[] }

  mock.store(on, stored)
  mock.clock(on, { now: 10 * 60 * 60_000 })
  on('command.register', () => ({ value: { command: 'dashboard' } }))
  on('tool.register', (_, e) => ({ value: { tool: `mcp__dashboard__${e.name}` } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('prompt.fill', (_, e) => {
    seen.filled.push(e.text)
    return { isFilled: true }
  })
  on('prompt.submit', (_, e) => {
    seen.submitted.push(e.text)
    return { text: e.text }
  })

  return seen
}

async function start($: Engine) {
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
}

test('eingetragene Nachrichten erscheinen, doppelte werden übersprungen', async ($, on) => {
  world(on)
  await start($)

  const first = await $.tool.call({ tool: 'mcp__dashboard__nachrichten_eintragen', nachrichten: [LENA, MAX] })
  const again = await $.tool.call({ tool: 'mcp__dashboard__nachrichten_eintragen', nachrichten: [LENA] })
  expect(first.result).toBe('2 neue Nachricht(en) eingetragen, 0 schon vorhanden.')
  expect(again.result).toBe('0 neue Nachricht(en) eingetragen, 1 schon vorhanden.')

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Button', text: 'Nachrichten (2 offen)' })).toBeDefined()
  await ui.press({ key: 'tab-nachrichten' })
  expect(await ui.find({ type: 'Button', text: /Lena/ })).toBeDefined()
  expect(await ui.find({ type: 'Button', text: /Max/ })).toBeDefined()
  await ui.unmount()
})

test('der Quellenfilter zeigt nur Nachrichten dieser Quelle', async ($, on) => {
  world(on)
  await start($)
  await $.tool.call({ tool: 'mcp__dashboard__nachrichten_eintragen', nachrichten: [LENA, MAX] })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'tab-nachrichten' })
  await ui.select({ key: 'quelle', value: 'Slack' })

  expect(await ui.find({ type: 'Button', text: /Max/ })).toBeDefined()
  expect(await ui.find({ type: 'Button', text: /Lena/ })).toBeUndefined()
  await ui.unmount()
})

test('Antworten legt einen Entwurf ins Eingabefeld, Erledigt senkt den Zähler', async ($, on) => {
  const seen = world(on)
  await start($)
  await $.tool.call({ tool: 'mcp__dashboard__nachrichten_eintragen', nachrichten: [LENA] })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'tab-nachrichten' })
  const lena = await ui.find({ type: 'Button', text: /Lena/ })
  await ui.press({ key: lena?.key ?? '' })
  const reply = await ui.find({ type: 'Button', text: 'Antworten' })
  await ui.press({ key: reply?.key ?? '' })

  expect(seen.filled.length).toBe(1)
  expect(seen.filled[0]).toMatch(/Lena/)
  expect(seen.filled[0]).toMatch(/> Passt dir Dienstag\?/)
  expect(seen.filled[0]).toMatch(/nichts senden/)

  const done = await ui.find({ type: 'Button', text: 'Erledigt' })
  await ui.press({ key: done?.key ?? '' })
  expect(await ui.find({ type: 'Button', text: 'Nachrichten (0 offen)' })).toBeDefined()
  await ui.unmount()
})

test('Abrufen bittet Claude, neue Nachrichten einzutragen', async ($, on) => {
  const seen = world(on)
  await start($)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'tab-nachrichten' })
  await ui.press({ key: 'abrufen' })

  expect(seen.submitted.length).toBe(1)
  expect(seen.submitted[0]).toMatch(/mcp__dashboard__nachrichten_eintragen/)
  await ui.unmount()
})

test('To-dos: eintippen, abhaken, Claude trägt ein und liest', async ($, on) => {
  world(on)
  await start($)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.input({ key: 'neu-0', text: 'Milch kaufen' })
  expect(await ui.find({ type: 'Button', text: 'To-dos (1)' })).toBeDefined()

  const milk = await ui.find({ type: 'Button', text: /Milch kaufen/ })
  await ui.press({ key: milk?.key ?? '' })
  expect(await ui.find({ type: 'Button', text: 'To-dos (0)' })).toBeDefined()

  await $.tool.call({ tool: 'mcp__dashboard__todo_eintragen', aufgaben: ['Steuer machen'] })
  expect(await ui.find({ type: 'Button', text: 'To-dos (1)' })).toBeDefined()

  const read = await $.tool.call({ tool: 'mcp__dashboard__dashboard_lesen' })
  expect(read.result).toMatch(/- Steuer machen/)
  expect(read.result).not.toMatch(/Milch kaufen/)
  await ui.unmount()
})

test('Antworten der Team-Agenten erscheinen als Nachrichten, andere Agenten nicht', async ($, on) => {
  world(on)
  on('agent.list', () => ({
    value: [
      { id: 'a1', description: 'Recherche: E-Rechnung', type: 'team:recherche', status: 'completed' },
      { id: 'a2', description: 'Dateien suchen', type: 'Explore', status: 'completed' },
      { id: 'a3', description: 'Mails holen', type: 'firma:posteingang', status: 'completed' },
    ],
  }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  await start($)

  for (const agentId of ['a1', 'a2', 'a3']) {
    await $.turn.complete({ turnId: `t-${agentId}`, agentId, answer: 'Liste ist fertig', durationMs: 1, isAborted: false, reason: 'answer' })
  }
  // A stopped run's last words stay out.
  await $.turn.complete({ turnId: 't-a1-stop', agentId: 'a1', answer: 'Jetzt lese ich …', durationMs: 1, isAborted: true, reason: 'aborted' })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Button', text: 'Nachrichten (2 offen)' })).toBeDefined()
  await ui.press({ key: 'tab-nachrichten' })
  expect(await ui.find({ type: 'Button', text: /Recherche-Agent/ })).toBeDefined()
  expect(await ui.find({ type: 'Button', text: /Posteingang · Firma/ })).toBeDefined()
  await ui.unmount()
})

test('gespeicherte To-dos kommen in einer neuen Sitzung zurück, auch auf dem Handy', async ($, on) => {
  world(on, {
    'todos-1': [{ id: 'a', text: 'Alte Aufgabe', isDone: false, createdAt: 0 }],
  })
  await start($)

  const ui = await $.ui.mount({ ...PANE, surface: 'mobile' })
  expect(await ui.find({ type: 'Button', text: /Alte Aufgabe/ })).toBeDefined()
  await ui.unmount()
})

test('eine neue Installation übernimmt die Daten aus seed.json einmal und leert die Datei', async ($, on) => {
  world(on)
  const written: string[] = []
  on('fs.read', () => ({
    value: JSON.stringify({ 'todos-1': [{ id: 's', text: 'Aus der alten Sitzung', isDone: false, createdAt: 0 }] }),
  }))
  on('fs.write', (_, e) => {
    written.push(e.text)
    return { value: undefined }
  })
  await start($)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Button', text: /Aus der alten Sitzung/ })).toBeDefined()
  expect(written).toEqual(['{}'])
  await ui.unmount()
})

test('mit vorhandenen Daten wird seed.json nicht angefasst', async ($, on) => {
  world(on, { 'todos-1': [{ id: 'a', text: 'Schon da', isDone: false, createdAt: 0 }] })
  let reads = 0
  on('fs.read', () => {
    reads += 1
    return { value: '{}' }
  })
  await start($)

  expect(reads).toBe(0)
})
