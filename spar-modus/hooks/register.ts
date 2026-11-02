import type { Engine, Register } from 'claude-code'

const HAIKU = 'haiku'
// Up to this much context Haiku can read the chat without a warm cache and
// still cost less than the main model reading it from its own cache.
const MAX_COLD_CONTEXT = 40_000
// Haiku's prompt cache stays warm for about five minutes after its last request.
const HAIKU_CACHE_MS = 4 * 60 * 1000
// Obvious small jobs, recognised without asking a model.
const QUICK = /(tippfehler|rechtschreib|grammatik|typo|spelling|formatier|übersetz|uebersetz|translate)/i
const QUICK_MAX_CHARS = 400
const LABELS = ['trivial', 'moderate', 'complex'] as const

type Force = 'haiku' | 'main' | undefined
type Choice = { model?: string; status?: string }
type Memory = { lastContext: number; haikuWarmUntil: number }

async function isOn($: Engine) {
  return (await $.store.get('isOn')) !== false
}

async function idleStatus($: Engine) {
  return (await isOn($)) ? 'Spar-Modus an' : 'Spar-Modus aus'
}

function excerpt(text: string) {
  return text.length > 1500 ? `${text.slice(0, 1000)}\n…\n${text.slice(-500)}` : text
}

async function isSmall($: Engine, text: string) {
  if (text.length <= QUICK_MAX_CHARS && QUICK.test(text)) {
    return true
  }

  try {
    return (await $.model.classify(excerpt(text), LABELS)) === 'trivial'
  } catch {
    return false
  }
}

async function choose($: Engine, text: string, force: Force, memory: Memory): Promise<Choice> {
  if (force === 'main') {
    return { status: 'Hauptmodell (per !opus)' }
  }
  if (force === 'haiku') {
    return { model: HAIKU, status: '⚡ Haiku (per !haiku)' }
  }
  if (text.trim() === '') {
    return {}
  }
  if (!(await isOn($))) {
    return { status: 'Spar-Modus aus' }
  }

  const isWarm = (await $.clock.now()) < memory.haikuWarmUntil
  if (memory.lastContext > MAX_COLD_CONTEXT && !isWarm) {
    return { status: 'Spar-Modus: langer Chat, Hauptmodell bleibt' }
  }
  if (await isSmall($, text)) {
    return { model: HAIKU, status: '⚡ Haiku übernimmt (Kleinkram)' }
  }

  return { status: 'Spar-Modus an' }
}

async function countRouted($: Engine) {
  const total = Number((await $.store.get('routedTotal')) ?? 0) + 1
  await $.store.set('routedTotal', total)
}

async function report($: Engine, routed: number, turns: number) {
  const total = Number((await $.store.get('routedTotal')) ?? 0)

  return [
    `Spar-Modus ist ${(await isOn($)) ? 'an' : 'aus'}.`,
    `Diese Sitzung: ${routed} von ${turns} Anfragen über Haiku, insgesamt ${total}.`,
    'Tipp: !opus oder !haiku am Anfang einer Nachricht erzwingt das Modell.',
  ].join('\n')
}

export const register: Register = on => {
  let forced: Force
  let turns = 0
  let routed = 0
  const memory: Memory = { lastContext: 0, haikuWarmUntil: 0 }
  const routes = new Map<string, string>()

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'spar',
      description: 'Spar-Modus: Kleinkram automatisch über Haiku',
      argumentHint: '[an|aus|status]',
    })
    $.ui.status(await idleStatus($))

    return next(e)
  })

  on('command.run', { command: 'spar' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()

    if (arg === 'an' || arg === 'on') {
      await $.store.set('isOn', true)
    } else if (arg === 'aus' || arg === 'off') {
      await $.store.set('isOn', false)
    } else if (arg !== '' && arg !== 'status') {
      return { text: 'Aufruf: /spar an, /spar aus oder /spar status' }
    }

    $.ui.status(await idleStatus($))

    return { text: await report($, routed, turns) }
  })

  on('prompt.submit', ($, e, next) => {
    // A prompt folded into a running turn starts none, so it picks no model.
    if (e.command !== undefined || e.isMeta || e.turnId !== undefined) {
      return next(e)
    }

    const prefix = /^\s*!(opus|haiku)\b\s*/i.exec(e.text)
    if (prefix === null) {
      return next(e)
    }

    forced = prefix[1]?.toLowerCase() === 'haiku' ? 'haiku' : 'main'

    return next({ ...e, text: e.text.slice(prefix[0].length) })
  }).catch(($, e, next) => next(e))

  on('turn.start', async ($, e, next) => {
    if (e.agentId !== undefined) {
      return next(e)
    }

    const force = forced
    forced = undefined
    const choice = await choose($, e.text, force, memory)

    if (e.text.trim() !== '') {
      turns += 1
    }
    if (choice.model !== undefined) {
      routes.set(e.turnId, choice.model)
      routed += 1
      await countRouted($)
    }
    if (choice.status !== undefined) {
      $.ui.status(choice.status)
    }

    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    if (e.agentId !== undefined) {
      return yield* next(e)
    }

    const model = routes.get(e.turnId)
    const step = yield* next(model === undefined ? e : { ...e, model, effort: 'low' })

    if (step.usage !== null) {
      const u = step.usage
      memory.lastContext = u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens
    }
    if (model !== undefined) {
      memory.haikuWarmUntil = (await $.clock.now()) + HAIKU_CACHE_MS
    }

    return step
  })

  on('turn.complete', ($, e, next) => {
    if (e.agentId === undefined) {
      routes.delete(e.turnId)
    }

    return next(e)
  })
}
