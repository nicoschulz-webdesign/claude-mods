import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

const MAIN = 'claude-opus-5-5'

// Stands for the engine beneath the mod and records what each step was sent with.
function world(on: On, label = 'complex') {
  const seen = { models: [] as string[], efforts: [] as unknown[], texts: [] as string[], context: 5_000 }

  mock.store(on)
  mock.clock(on, { now: 1_000_000 })
  on('command.register', () => ({ value: { command: 'spar' } }))
  on('model.classify', () => ({ value: label }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('prompt.submit', (_, e) => {
    seen.texts.push(e.text)
    return { text: e.text }
  })
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.step', async function* (_, e) {
    seen.models.push(e.model)
    seen.efforts.push(e.effort)
    return {
      turnId: e.turnId,
      index: e.index,
      answer: 'ok',
      toolUses: [],
      stopReason: 'end_turn' as const,
      usage: {
        model: e.model,
        input_tokens: 100,
        output_tokens: 50,
        cache_read_input_tokens: seen.context,
        cache_creation_input_tokens: 0,
      },
    }
  })
  on('turn.complete', (_, e) => ({ text: e.answer }))

  return seen
}

async function turn($: Engine, turnId: string, text: string) {
  await $.prompt.submit({ text })
  await $.turn.start({ text, turnId })
  const stream = $.turn.step({ turnId, index: 0, model: MAIN, effort: 'high', messageCount: 3 })
  for await (const _ of stream) {
    // drained
  }
  await $.turn.complete({ turnId, answer: 'ok', durationMs: 1, isAborted: false, reason: 'answer' })
}

async function start($: Engine) {
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
}

test('Kleinkram geht an Haiku', async ($, on) => {
  const seen = world(on)
  await start($)

  await turn($, 't1', 'Korrigiere die Tippfehler: Hallo Wlet')

  expect(seen.models).toEqual(['haiku'])
  expect(seen.efforts).toEqual(['low'])
})

test('eine schwere Aufgabe bleibt beim Hauptmodell', async ($, on) => {
  const seen = world(on, 'complex')
  await start($)

  await turn($, 't1', 'Baue mir eine REST-API mit Login und Datenbank')

  expect(seen.models).toEqual([MAIN])
  expect(seen.efforts).toEqual(['high'])
})

test('der Klassifizierer kann Haiku wählen', async ($, on) => {
  const seen = world(on, 'trivial')
  await start($)

  await turn($, 't1', 'Was ist die Hauptstadt von Frankreich?')

  expect(seen.models).toEqual(['haiku'])
})

test('!opus erzwingt das Hauptmodell und verschwindet aus der Nachricht', async ($, on) => {
  const seen = world(on)
  await start($)

  await $.prompt.submit({ text: '!opus korrigiere die Tippfehler' })
  await $.turn.start({ text: 'korrigiere die Tippfehler', turnId: 't1' })
  for await (const _ of $.turn.step({ turnId: 't1', index: 0, model: MAIN, messageCount: 1 })) {
    // drained
  }

  expect(seen.texts).toEqual(['korrigiere die Tippfehler'])
  expect(seen.models).toEqual([MAIN])
})

test('/spar aus schaltet das Umleiten ab', async ($, on) => {
  const seen = world(on)
  await start($)

  const ran = await $.command.run({ command: 'spar', args: 'aus' })
  await turn($, 't1', 'Korrigiere die Tippfehler: Hallo Wlet')

  expect(ran.text).toMatch(/Spar-Modus ist aus/)
  expect(seen.models).toEqual([MAIN])
})

test('in einem langen Chat bleibt das Hauptmodell, außer Haikus Cache ist warm', async ($, on) => {
  const seen = world(on)
  await start($)

  seen.context = 60_000
  await turn($, 't1', 'Baue mir eine REST-API mit Login und Datenbank')
  await turn($, 't2', 'Korrigiere die Tippfehler: Hallo Wlet')
  await turn($, 't3', '!haiku formatiere das')
  await turn($, 't4', 'Übersetze das ins Englische')

  expect(seen.models).toEqual([MAIN, MAIN, 'haiku', 'haiku'])
})
