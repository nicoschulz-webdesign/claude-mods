import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

const GMAIL = 'mcp__abc__COMPOSIO_MULTI_EXECUTE_TOOL'
const BROWSE = 'mcp__Claude_Browser__navigate'
const ROOT = 'C:\\Users\\test\\Webprojekte'
const USAGE = { model: 'x', input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 9000, cache_creation_input_tokens: 500 }
const PANE = {
  plugin: 'firma',
  component: 'Pane',
  requestId: 'firma',
  props: {
    title: 'Firma',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 60 },
    view: {},
  },
} as const

type Spec = { name: string; model?: string; tools?: readonly string[] }

// Stands for the engine beneath the mod and records what the mod asked of it.
function world(on: On) {
  const seen = {
    agents: [] as Spec[],
    spawnModels: [] as (string | undefined)[],
    submitted: [] as string[],
    toasts: [] as string[],
    statuses: [] as (string | undefined)[],
    efforts: [] as unknown[],
    context: 0,
    compacted: [] as (string | undefined)[],
    clock: mock.clock(on, { now: 1_800_000_000_000 }),
  }

  mock.store(on)
  mock.env(on, { USERPROFILE: 'C:\\Users\\test' })
  on('agent.register', (_, e) => {
    seen.agents.push(e)
    return { value: { agent: `firma:${e.name}` } }
  })
  on('command.register', () => ({ value: { command: 'firma' } }))
  on('tool.register', (_, e) => ({ value: { tool: `mcp__firma__${e.name}` } }))
  on('tool.list', () => ({
    value: [
      { name: GMAIL },
      { name: 'mcp__dashboard__todo_eintragen' },
      { name: 'Read' },
      { name: 'PowerShell' },
      { name: BROWSE },
      { name: 'mcp__Claude_Browser__computer' },
    ],
  }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.status', (_, e) => {
    seen.statuses.push(e.text)
    return { value: undefined }
  })
  on('ui.toast', (_, e) => {
    seen.toasts.push(e.text)
    return { value: undefined }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('prompt.submit', (_, e) => {
    seen.submitted.push(e.text)
    return { text: e.text }
  })
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.step', async function* (_, e) {
    seen.efforts.push(e.effort)
    const usage =
      seen.context > 0
        ? { model: 'x', input_tokens: 0, output_tokens: 10, cache_read_input_tokens: seen.context, cache_creation_input_tokens: 0 }
        : null
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn' as const, usage }
  })
  on('session.compact', (_, e) => {
    seen.compacted.push(e?.instructions)
    return { messages: [{ role: 'user' as const, text: 'Zusammenfassung', toolUses: [] }] }
  })
  on('prompt.compose', () => ({ sections: [] }))
  on('agent.spawn', (_, e) => {
    seen.spawnModels.push(e.model)
    return { model: e.model ?? 'inherit', agentId: `id-${e.subagentType}` }
  })
  on('tool.call', () => ({ result: 'ok' }))
  on('tool.check', () => ({ decision: 'ask' as const }))
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

async function chef($: Engine, turnId: string, task = 'Sortier meine Mails') {
  await $.turn.start({ text: `[Firma-Chef] Du bist der Chef … Auftrag: ${task}`, turnId })
}

async function call($: Engine, tool: string, input: Record<string, unknown>, agentId?: string) {
  return JSON.stringify(await $.tool.call({ tool, agentId, ...input }))
}

test('Code und Endabnahme auf Opus, Prüfung auf Sonnet, Vorarbeit günstig', async ($, on) => {
  const seen = world(on)
  await start($)

  const latest = (name: string) => seen.agents.filter(agent => agent.name === name).at(-1)
  const names = [...new Set(seen.agents.map(agent => agent.name))]
  expect(names).toEqual([
    'posteingang',
    'verwaltung',
    'recherche',
    'marketing',
    'texte',
    'vorbereitung',
    'konzept',
    'webdesign',
    'entwicklung',
    'qualitaet',
    'abnahme',
  ])
  expect(names.filter(name => latest(name)?.model === 'opus')).toEqual(['webdesign', 'entwicklung', 'abnahme'])
  expect(latest('qualitaet')?.model).toBe('sonnet')
  expect(latest('vorbereitung')?.model).toBe('haiku')
  expect(latest('qualitaet')?.tools).toEqual(expect.arrayContaining(['PowerShell', BROWSE, 'Skill']))
  expect(seen.agents.filter(agent => agent.tools?.includes(GMAIL)).map(agent => agent.name)).toEqual(['posteingang'])
})

test('Webdesign läuft immer auf Opus und schreibt nur in Projektordner', async ($, on) => {
  const seen = world(on)
  await start($)
  await $.agent.spawn({ prompt: 'Bau die Seite', subagentType: 'firma:webdesign', model: 'sonnet' })
  const agentId = 'id-firma:webdesign'
  const inside = { file_path: `${ROOT}\\tischlerei\\index.html`, content: '<html></html>' }
  const outside = { file_path: 'C:\\Users\\test\\Desktop\\x.html', content: '' }
  const sneaky = { file_path: `${ROOT}\\..\\.ssh\\config`, content: '' }

  expect(seen.spawnModels).toEqual(['opus'])
  expect(await call($, 'Write', inside, agentId)).toMatch(/ok/)
  expect(await call($, 'Write', outside, agentId)).toMatch(/nur in Projektordner/)
  expect(await call($, 'Write', sneaky, agentId)).toMatch(/nur in Projektordner/)
  expect((await $.tool.check({ tool: 'Write', input: inside, agentId, tool_use_id: 'w1' })).decision).toBe('allow')
  expect((await $.tool.check({ tool: 'Write', input: outside, agentId, tool_use_id: 'w2' })).decision).toBe('ask')
})

test('Vorarbeiter schreiben nur in die Projektakte und ins Firmenwissen', async ($, on) => {
  world(on)
  await start($)
  await $.agent.spawn({ prompt: 'Fragen', subagentType: 'firma:recherche' })
  const agentId = 'id-firma:recherche'

  expect(await call($, 'Write', { file_path: `${ROOT}\\tischlerei\\.firma\\RECHERCHE.md`, content: 'x' }, agentId)).toMatch(/ok/)
  expect(await call($, 'Write', { file_path: `${ROOT}\\_wissen\\tischler.md`, content: 'x' }, agentId)).toMatch(/ok/)
  expect(await call($, 'Write', { file_path: `${ROOT}\\tischlerei\\index.html`, content: 'x' }, agentId)).toMatch(/nur in die Projektakte/)
})

test('nichts wird doppelt gelesen, außer nach einer Änderung', async ($, on) => {
  world(on)
  await start($)
  await $.agent.spawn({ prompt: 'Bau', subagentType: 'firma:webdesign' })
  const agentId = 'id-firma:webdesign'
  const file = { file_path: `${ROOT}\\tischlerei\\.firma\\INHALT.md` }
  const skill = { skill: 'anthropic-skills:impeccable' }

  expect(await call($, 'Read', file, agentId)).toMatch(/ok/)
  expect(await call($, 'Read', file, agentId)).toMatch(/Schon gelesen/)
  expect(await call($, 'Read', { ...file, offset: 200 }, agentId)).toMatch(/ok/)
  expect(await call($, 'Skill', skill, agentId)).toMatch(/ok/)
  expect(await call($, 'Skill', skill, agentId)).toMatch(/Schon gelesen/)
  expect(await call($, 'Edit', { ...file, old_string: 'a', new_string: 'b' }, agentId)).toMatch(/ok/)
  expect(await call($, 'Read', file, agentId)).toMatch(/ok/)
})

test('die Qualitätskontrolle läuft auf Sonnet und darf nur die Vorschau starten und lokal ansehen', async ($, on) => {
  const seen = world(on)
  await start($)
  await $.agent.spawn({ prompt: 'Prüf die Seite', subagentType: 'firma:qualitaet', model: 'opus' })
  const agentId = 'id-firma:qualitaet'
  const server = { command: `python -m http.server 8801 --directory "${ROOT}\\tischlerei"` }

  expect(seen.spawnModels).toEqual(['sonnet'])
  expect(await call($, 'PowerShell', server, agentId)).toMatch(/ok/)
  expect((await $.tool.check({ tool: 'PowerShell', input: server, agentId, tool_use_id: 's1' })).decision).toBe('allow')
  expect((await $.tool.check({ tool: 'PowerShell', input: { command: 'python -m pytest' }, agentId, tool_use_id: 's2' })).decision).toBe('allow')
  expect((await $.tool.check({ tool: 'PowerShell', input: { command: 'Remove-Item -Recurse C:\\x' }, agentId, tool_use_id: 's3' })).decision).toBe('ask')
  expect((await $.tool.check({ tool: BROWSE, input: { url: 'http://localhost:8801/' }, agentId, tool_use_id: 'b1' })).decision).toBe('allow')
  expect((await $.tool.check({ tool: BROWSE, input: { url: 'https://example.com' }, agentId, tool_use_id: 'b2' })).decision).toBe('ask')
})

test('der Chef schreibt das Briefing ohne Rückfrage, aber nur während eines Auftrags', async ($, on) => {
  world(on)
  await start($)
  const briefing = { file_path: `${ROOT}\\tischlerei\\.firma\\BRIEFING.md`, content: 'x' }

  expect((await $.tool.check({ tool: 'Write', input: briefing, tool_use_id: 'c0' })).decision).toBe('ask')
  await chef($, 'c1', 'Erstell eine Webseite für eine Tischlerei')
  expect((await $.tool.check({ tool: 'Write', input: briefing, tool_use_id: 'c1' })).decision).toBe('allow')
})

test('Shell: Chef und Entwicklung ohne Rückfrage, Riskantes fragt, Endabnahme nur Vorschau', async ($, on) => {
  world(on)
  await start($)
  const check = async (command: string, agentId?: string, extra: Record<string, unknown> = {}) =>
    (await $.tool.check({ tool: 'PowerShell', input: { command, ...extra }, agentId, tool_use_id: command })).decision

  expect(await check('git status')).toBe('ask')
  await chef($, 'c1', 'Programmier ein Skript')
  expect(await check('git status')).toBe('allow')
  expect(await check('New-Item -ItemType Directory C:\\Users\\test\\Projekte\\x')).toBe('allow')
  for (const risky of ['git push origin main', 'Remove-Item x', 'curl https://a.b', 'npm install left-pad', 'iex (gc a.ps1)', 'type C:\\Users\\test\\.ssh\\id_rsa']) {
    expect(await check(risky)).toBe('ask')
  }

  await $.agent.spawn({ prompt: 'Bau', subagentType: 'firma:entwicklung' })
  expect(await check('python -m pytest', 'id-firma:entwicklung')).toBe('allow')
  expect(await check('python -m pytest', 'id-firma:entwicklung', { dangerouslyDisableSandbox: true })).toBe('ask')
  expect(await check('git push', 'id-firma:entwicklung')).toBe('ask')

  await $.agent.spawn({ prompt: 'Abnahme', subagentType: 'firma:abnahme' })
  expect(await call($, 'PowerShell', { command: 'python -m pytest' }, 'id-firma:abnahme')).toMatch(/nur die Vorschau/)
})

test('ein langer Chat wird zwischen Aufträgen automatisch zusammengefasst, nie mitten in einem', async ($, on) => {
  const seen = world(on)
  await start($)
  const turn = async (turnId: string, text: string) => {
    await $.turn.start({ text, turnId })
    for await (const _ of $.turn.step({ turnId, index: 0, model: 'opus', effort: 'high', messageCount: 9 })) {
      // drained
    }
  }

  seen.context = 200_000
  await chef($, 'c0')
  await $.agent.spawn({ prompt: 'x', subagentType: 'firma:recherche' })
  await turn('c0', '')
  await finish($, 'c0')
  await seen.clock.advance(1000)
  expect(seen.compacted).toEqual([])

  await finish($, 'r1', 'id-firma:recherche')
  await turn('t1', 'Danke')
  await finish($, 't1')
  await seen.clock.advance(1000)
  expect(seen.compacted.length).toBe(1)
  expect(seen.compacted[0]).toMatch(/Entscheidungen und Wünsche des Inhabers/)
})

test('das Firmengedächtnis steht in jedem Chat im Systemprompt', async ($, on) => {
  world(on)
  on('fs.read', () => ({ value: '- Tischlerei Kiel: Kunde will Grün statt Blau.' }))
  await start($)

  const composed = await $.prompt.compose({ promptModel: 'claude-opus-5-5', outputStyle: null, tools: [], traits: [], surfaces: [] })
  const memory = composed.sections.find(section => section.id === 'firma:gedaechtnis')
  if (memory === undefined) {
    throw new Error(JSON.stringify(composed).slice(0, 400))
  }
  expect(memory?.text).toMatch(/Kunde will Grün/)
  expect(memory?.text).toContain(`${ROOT}\\_wissen\\CHEF.md`)
})

test('Gmail: Lesen läuft ohne Rückfrage, Senden ist gesperrt', async ($, on) => {
  world(on)
  await start($)
  await $.agent.spawn({ prompt: 'Mails', subagentType: 'firma:posteingang' })
  const agentId = 'id-firma:posteingang'
  const fetch = { tools: [{ tool_slug: 'GMAIL_FETCH_EMAILS', arguments: {} }], sync_response_to_workbench: false }
  const send = { tools: [{ tool_slug: 'GMAIL_SEND_EMAIL', arguments: {} }], sync_response_to_workbench: false }

  expect(await call($, GMAIL, fetch, agentId)).toMatch(/ok/)
  expect(await call($, GMAIL, send, agentId)).toMatch(/nur lesen/)
  expect((await $.tool.check({ tool: GMAIL, input: fetch, agentId, tool_use_id: 't1' })).decision).toBe('allow')
  expect((await $.tool.check({ tool: GMAIL, input: send, agentId, tool_use_id: 't2' })).decision).toBe('ask')
})

test('der Chef delegiert: Websuche und Gmail sind ihm während des Auftrags gesperrt', async ($, on) => {
  world(on)
  await start($)

  expect(await call($, 'WebSearch', { query: 'vorher' })).toMatch(/ok/)
  await chef($, 'c1')
  expect(await call($, 'WebSearch', { query: 'selbst' })).toMatch(/Delegiere/)
  expect(await call($, GMAIL, { tools: [{ tool_slug: 'GMAIL_FETCH_EMAILS' }] })).toMatch(/posteingang/)
})

test('die Recherche wird nach 4 Suchen gestoppt und läuft immer auf Haiku', async ($, on) => {
  const seen = world(on)
  await start($)
  await $.agent.spawn({ prompt: 'Fragen', subagentType: 'firma:recherche', model: 'opus' })

  const results = []
  for (let i = 0; i < 5; i++) {
    results.push(await call($, 'WebSearch', { query: `q${i}` }, 'id-firma:recherche'))
  }

  expect(seen.spawnModels).toEqual(['haiku'])
  expect(results.slice(0, 4).every(one => one.includes('ok'))).toBe(true)
  expect(results[4]).toMatch(/Budget erschöpft/)
})

test('der Chef stellt selbst günstige Mitarbeiter ein, mit sicheren Grenzen und höchstens fünf', async ($, on) => {
  const seen = world(on)
  await start($)

  const first = await call($, 'mcp__firma__mitarbeiter_einstellen', {
    name: 'Bildrecherche',
    aufgabe: 'Sucht passende Bildideen.',
    anweisung: 'Du suchst Bildideen. Antwort höchstens 80 Wörter.',
    modell: 'opus',
    werkzeuge: ['WebSearch', 'Bash', 'Write'],
  })
  expect(first).toMatch(/als firma:bildrecherche eingestellt/)
  const hired = seen.agents.find(agent => agent.name === 'bildrecherche')
  expect(hired?.model).toBe('haiku')
  expect(hired?.tools).toEqual(['WebSearch'])

  for (const name of ['Zwei', 'Drei', 'Vier', 'Fünf']) {
    await call($, 'mcp__firma__mitarbeiter_einstellen', { name, aufgabe: 'x', anweisung: 'y', modell: 'haiku' })
  }
  expect(await call($, 'mcp__firma__mitarbeiter_einstellen', { name: 'Sechs', aufgabe: 'x', anweisung: 'y', modell: 'haiku' })).toMatch(
    /schon 5 Mitarbeiter/,
  )

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.findAll({ type: 'Button', text: 'entlassen' })).length).toBe(5)
  await ui.unmount()
})

test('fertig erst, wenn der Chef abgibt; Kosten pro Einsatz im Panel und für den Chef lesbar', async ($, on) => {
  const seen = world(on)
  await start($)

  await chef($, 'c1')
  await $.agent.spawn({ prompt: 'Mails', subagentType: 'firma:posteingang' })
  await finish($, 'c1')
  expect(seen.toasts).toEqual([])

  await finish($, 'p1', 'id-firma:posteingang')
  await $.turn.start({ text: '', turnId: 'c2' })
  await finish($, 'c2')

  expect(seen.toasts).toEqual(['Auftrag erledigt · Chef 4k · Posteingang 2k Token'])
  expect(seen.statuses.at(-1)).toBeUndefined()
  expect(await call($, 'mcp__firma__kosten_lesen', {})).toMatch(/Posteingang: 2000 Token in 1 Einsätzen \(Ø 2000\)/)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: 'Gesamt 6k Token' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /4k Token · 1× · Ø 4k/ })).toBeDefined()
  await ui.unmount()
})

test('bei Web- und Code-Aufträgen denkt der Chef gründlicher, sonst sparsam', async ($, on) => {
  const seen = world(on)
  await start($)

  const think = async (turnId: string) => {
    for await (const _ of $.turn.step({ turnId, index: 0, model: 'opus', effort: 'max', messageCount: 1 })) {
      // drained
    }
  }
  await chef($, 'w1', 'Erstell eine Webseite für eine Tischlerei')
  await think('w1')
  await finish($, 'w1')
  await chef($, 'm1', 'Sortier meine Mails')
  await think('m1')

  expect(seen.efforts).toEqual(['high', 'medium'])
})

test('der Auftrag an den Chef enthält Sparregeln, Projektakte und beide Abläufe', async ($, on) => {
  const seen = world(on)
  await start($)

  await $.command.run({ command: 'firma', args: 'Erstell eine Webseite für eine Tischlerei in Kiel' })
  await seen.clock.advance(100)
  const prompt = seen.submitted[0] ?? ''

  expect(prompt).toMatch(/^\[Firma-Chef\]/)
  expect(prompt).toContain(`${ROOT}\\<projektname>`)
  expect(prompt).toContain(`${ROOT}\\_wissen`)
  expect(prompt).toMatch(/Sparregeln/)
  expect(prompt).toMatch(/Alles wird einmal gelesen/)
  expect(prompt).toMatch(/firma:konzept/)
  expect(prompt).toMatch(/firma:abnahme einmal/)
  expect(prompt).toMatch(/firma:vorbereitung schreibt die KARTE\.md/)
  expect(prompt).toMatch(/kein GitHub-Push/)
})

test('/firma morgen übergibt dem Chef kurz danach die Morgenroutine', async ($, on) => {
  const seen = world(on)
  await start($)

  const ran = await $.command.run({ command: 'firma', args: 'morgen' })
  expect(seen.submitted.length).toBe(0)
  await seen.clock.advance(100)

  expect(ran.text).toBe('Morgenroutine gestartet.')
  expect(seen.submitted[0]).toMatch(/Morgenroutine/)
})

test('ein gestoppter Mitarbeiter beendet den Auftrag sauber', async ($, on) => {
  const seen = world(on)
  await start($)

  await chef($, 'c1')
  await $.agent.spawn({ prompt: 'Fragen', subagentType: 'firma:recherche' })
  await finish($, 'c1')
  await finish($, 'r1', 'id-firma:recherche', true)

  expect(seen.toasts[0]).toMatch(/^Auftrag gestoppt/)
  expect((await $.command.run({ command: 'firma', args: 'stop' })).text).toBe('Es läuft kein Auftrag.')
})
