import { atom, read, update } from 'claude-code'
import type { Engine, Register } from 'claude-code'

import type { Message, Todo } from '../types'

const PANE = 'dashboard'
const TITLE = 'Dashboard'
const MAX_MESSAGES = 300
// Change a tag (and its store key) when that list's fields change: an earlier
// version's value is then declined instead of drawn.
const todos = atom({ plugin: 'dashboard', key: 'todos' } as const, [], { shape: 'todos-1' })
const messages = atom({ plugin: 'dashboard', key: 'messages' } as const, [], { shape: 'messages-1' })
const tab = atom({ plugin: 'dashboard', key: 'tab' } as const, 'todos')
const showAll = atom({ plugin: 'dashboard', key: 'showAll' } as const, false)
const source = atom({ plugin: 'dashboard', key: 'source' } as const, 'alle')
const openId = atom({ plugin: 'dashboard', key: 'openId' } as const, '')

// Agents of the team mod whose answers show up as messages; the firm's
// employees (firma:<name>) do too, under their name.
const TEAM_NAMES: Record<string, string> = {
  'team:recherche': 'Recherche-Agent',
  'team:entwuerfe': 'Entwürfe-Agent',
}

function senderOf(type: string) {
  if (TEAM_NAMES[type] !== undefined) {
    return { source: 'Team', from: TEAM_NAMES[type] }
  }
  if (type.startsWith('firma:') && type.length > 'firma:'.length) {
    const name = type.slice('firma:'.length)
    return { source: 'Firma', from: name.charAt(0).toUpperCase() + name.slice(1) }
  }
  return undefined
}

const FETCH_PROMPT = [
  'Hole meine neuen Nachrichten aus den verbundenen Quellen (zum Beispiel Gmail über Composio)',
  'und trage sie mit dem Werkzeug mcp__dashboard__nachrichten_eintragen in mein Dashboard ein.',
  'Nur lesen und eintragen, nichts senden, verschieben oder löschen.',
  'Wenn keine Quelle verbunden ist, sag mir das kurz.',
].join(' ')

const TOOLS = [
  {
    name: 'todo_eintragen',
    description: 'Trägt Aufgaben in den Reiter To-dos des Dashboards ein, das der Nutzer neben dem Chat sieht.',
    inputSchema: {
      type: 'object',
      properties: {
        aufgaben: { type: 'array', items: { type: 'string' }, description: 'Die Aufgaben, je ein kurzer Satz.' },
      },
      required: ['aufgaben'],
    },
  },
  {
    name: 'nachrichten_eintragen',
    description:
      'Trägt Nachrichten (E-Mails, Chats, Meldungen) in den Reiter Nachrichten des Dashboards ein. ' +
      'Schon eingetragene Nachrichten (gleiche quelle und id) werden übersprungen.',
    inputSchema: {
      type: 'object',
      properties: {
        nachrichten: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: 'Die Kennung der Nachricht in ihrer Quelle, etwa die Gmail-Message-ID.' },
              quelle: { type: 'string', description: 'Woher sie kommt: Gmail, Slack, Outlook, Agent ...' },
              von: { type: 'string', description: 'Absender, Name oder Adresse.' },
              betreff: { type: 'string' },
              text: { type: 'string', description: 'Der Inhalt als reiner Text.' },
              zeit: { type: 'string', description: 'Empfangszeit im ISO-Format.' },
            },
            required: ['von', 'text'],
          },
        },
      },
      required: ['nachrichten'],
    },
  },
  {
    name: 'dashboard_lesen',
    description: 'Liest die offenen To-dos und die offenen Nachrichten aus dem Dashboard des Nutzers.',
    inputSchema: { type: 'object', properties: {} },
  },
]

function newId(now: number) {
  return `${now.toString(36)}${Math.random().toString(36).slice(2, 8)}`
}

function hash(text: string) {
  let h = 5381
  for (let i = 0; i < text.length; i++) {
    h = ((h * 33) ^ text.charCodeAt(i)) >>> 0
  }
  return h.toString(36)
}

function field(item: Record<string, unknown>, name: string) {
  const value = item[name]
  return typeof value === 'string' ? value.trim() : ''
}

function parseTodos(raw: unknown) {
  return Array.isArray(raw)
    ? raw.filter((text): text is string => typeof text === 'string').map(text => text.trim()).filter(text => text !== '')
    : []
}

function parseMessages(raw: unknown, now: number): Message[] {
  if (!Array.isArray(raw)) {
    return []
  }

  return raw.flatMap((entry): Message[] => {
    if (typeof entry !== 'object' || entry === null) {
      return []
    }

    const item = entry as Record<string, unknown>
    const from = field(item, 'von')
    const text = field(item, 'text')
    if (from === '' || text === '') {
      return []
    }

    const origin = field(item, 'quelle') || 'Claude'
    const subject = field(item, 'betreff')
    const at = Date.parse(field(item, 'zeit'))
    const key = field(item, 'id') || `${from}\n${subject}\n${text.slice(0, 80)}`

    return [
      {
        id: hash(`${origin}\n${key}`),
        source: origin,
        from,
        subject,
        text,
        receivedAt: Number.isNaN(at) ? now : at,
        isDone: false,
      },
    ]
  })
}

function when(at: number, now: number) {
  const minutes = Math.round((now - at) / 60_000)
  if (minutes < 1) {
    return 'gerade eben'
  }
  if (minutes < 60) {
    return `vor ${minutes} Min.`
  }
  const hours = Math.round(minutes / 60)
  if (hours < 24) {
    return `vor ${hours} Std.`
  }
  const days = Math.round(hours / 24)
  return days === 1 ? 'gestern' : `vor ${days} Tagen`
}

function summary(list: readonly Todo[], inbox: readonly Message[]) {
  const open = list.filter(todo => !todo.isDone)
  const unread = inbox.filter(message => !message.isDone)
  const lines = [`Offene To-dos (${open.length}):`, ...open.map(todo => `- ${todo.text}`)]

  lines.push('', `Offene Nachrichten (${unread.length}):`)
  for (const message of unread) {
    const about = message.subject === '' ? '' : ` | ${message.subject}`
    lines.push(`- ${message.from} (${message.source})${about}: ${message.text.slice(0, 200)}`)
  }

  return lines.join('\n')
}

async function changeTodos($: Engine, change: (list: Todo[]) => Todo[]) {
  const saved = await update($, todos, list => change([...list]))
  await $.store.set('todos-1', saved)
}

async function changeMessages($: Engine, change: (list: Message[]) => Message[]) {
  const saved = await update($, messages, list => change([...list]).slice(-MAX_MESSAGES))
  await $.store.set('messages-1', saved)
}

// Data carried over from an earlier install, read once into an empty store
// and then emptied, so it is neither imported twice nor left lying around.
async function importSeed($: Engine) {
  const path = `${$.plugin.root}/seed.json`
  try {
    const seed = JSON.parse(await $.fs.read(path)) as Record<string, unknown>
    if (Array.isArray(seed['todos-1'])) {
      await $.store.set('todos-1', seed['todos-1'])
    }
    if (Array.isArray(seed['messages-1'])) {
      await $.store.set('messages-1', seed['messages-1'])
    }
    await $.fs.write(path, '{}')
  } catch {
    // No seed, or not readable: start empty.
  }
}

async function restore($: Engine) {
  if ((await $.store.get('todos-1')) === undefined && (await $.store.get('messages-1')) === undefined) {
    await importSeed($)
  }

  const savedTodos = await $.store.get('todos-1')
  const savedMessages = await $.store.get('messages-1')

  if (Array.isArray(savedTodos)) {
    await update($, todos, () => savedTodos as Todo[])
  }
  if (Array.isArray(savedMessages)) {
    await update($, messages, () => savedMessages as Message[])
  }
}

async function addTodos($: Engine, texts: readonly string[]) {
  const now = await $.clock.now()
  await changeTodos($, list => [
    ...list,
    ...texts.map(text => ({ id: newId(now), text, isDone: false, createdAt: now })),
  ])
}

async function addMessages($: Engine, incoming: readonly Message[]) {
  let added = 0
  await changeMessages($, list => {
    const known = new Set(list.map(message => message.id))
    const fresh = incoming.filter(message => !known.has(message.id))
    added = fresh.length
    return [...list, ...fresh]
  })
  return added
}

async function recordTeamAnswer($: Engine, agentId: string, turnId: string, answer: string) {
  if (answer.trim() === '') {
    return
  }

  const agent = (await $.agent.list()).find(one => one.id === agentId)
  const sender = agent === undefined ? undefined : senderOf(agent.type)
  if (agent === undefined || sender === undefined) {
    return
  }

  await addMessages($, [
    {
      id: hash(`${sender.source}\n${agentId}\n${turnId}`),
      source: sender.source,
      from: sender.from,
      subject: agent.description,
      text: answer,
      receivedAt: await $.clock.now(),
      isDone: false,
    },
  ])
}

async function draftReply($: Engine, message: Message) {
  const about = message.subject === '' ? '' : `, Betreff: ${message.subject}`
  const quoted = message.text.slice(0, 4000).replace(/^/gm, '> ')
  await $.prompt.fill({
    text:
      `Entwirf eine Antwort auf diese Nachricht von ${message.from} (${message.source}${about}). ` +
      `Nur ein Entwurf, nichts senden:\n\n${quoted}\n\nMeine Stichpunkte: `,
  })
}

async function openPane($: Engine) {
  return $.ui.open({ id: PANE, title: TITLE })
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await restore($)
    await $.command.register({ name: 'dashboard', description: 'Öffnet das Dashboard mit To-dos und Nachrichten' })
    for (const tool of TOOLS) {
      await $.tool.register(tool)
    }
    void openPane($)

    return next(e)
  })

  on('command.run', { command: 'dashboard' }, async $ => {
    const opened = await openPane($)

    return { text: opened.isPlaced ? 'Dashboard geöffnet.' : `Dashboard wartet: ${opened.reason}` }
  })

  on('tool.call', { tool: 'mcp__dashboard__todo_eintragen' }, async ($, e) => {
    const texts = parseTodos(e.aufgaben)
    if (texts.length === 0) {
      return { result: 'Keine Aufgabe angegeben.' }
    }

    await addTodos($, texts)

    return { result: `${texts.length} Aufgabe(n) eingetragen.` }
  }).catch(() => ({ deny: 'Das Dashboard konnte die Aufgaben nicht speichern.' }))

  on('tool.call', { tool: 'mcp__dashboard__nachrichten_eintragen' }, async ($, e) => {
    const incoming = parseMessages(e.nachrichten, await $.clock.now())
    if (incoming.length === 0) {
      return { result: 'Keine gültige Nachricht angegeben (nötig sind von und text).' }
    }

    const added = await addMessages($, incoming)

    return { result: `${added} neue Nachricht(en) eingetragen, ${incoming.length - added} schon vorhanden.` }
  }).catch(() => ({ deny: 'Das Dashboard konnte die Nachrichten nicht speichern.' }))

  on('tool.call', { tool: 'mcp__dashboard__dashboard_lesen' }, async $ => {
    const [list, inbox] = await Promise.all([read($, todos), read($, messages)])

    return { result: summary(list, inbox) }
  }).catch(() => ({ deny: 'Das Dashboard konnte nicht gelesen werden.' }))

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    // A stopped agent's last words are no result.
    if (e.agentId !== undefined && !e.isAborted && e.reason === 'answer') {
      await recordTeamAnswer($, e.agentId, e.turnId, e.answer)
    }

    return done
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const els = $.ui.resolve(e)
    const { Box, Button, Text } = els
    const Input = 'Input' in els ? els.Input : undefined
    const Select = 'Select' in els ? els.Select : undefined
    const [list, inbox, current, isAll, origin, opened, now] = await Promise.all([
      read($, todos),
      read($, messages),
      read($, tab),
      read($, showAll),
      read($, source),
      read($, openId),
      $.clock.now(),
    ])

    const openTodos = list.filter(todo => !todo.isDone).length
    const openMessages = inbox.filter(message => !message.isDone).length
    const header = (
      <Box flexDirection="row" gap="sm">
        <Button
          key="tab-todos"
          label={`To-dos (${openTodos})`}
          variant={current === 'todos' ? 'primary' : 'secondary'}
          onPress={() => update($, tab, () => 'todos')}
        />
        <Button
          key="tab-nachrichten"
          label={`Nachrichten (${openMessages} offen)`}
          variant={current === 'nachrichten' ? 'primary' : 'secondary'}
          onPress={() => update($, tab, () => 'nachrichten')}
        />
      </Box>
    )

    if (current === 'todos') {
      const done = list.filter(todo => todo.isDone).length
      const sorted = [...list.filter(todo => !todo.isDone), ...list.filter(todo => todo.isDone)]

      return (
        <Box flexDirection="column" gap="sm">
          {header}
          {Input !== undefined && (
            <Input
              key={`neu-${list.length}`}
              placeholder="Neue Aufgabe …"
              submitLabel="hinzufügen"
              onSubmit={text => (text.trim() === '' ? undefined : addTodos($, [text.trim()]))}
            />
          )}
          {list.length === 0 && <Text dimColor>Noch keine Aufgaben. Du kannst Claude auch sagen: „Schreib auf meine Liste: …“</Text>}
          {sorted.map(todo => (
            <Box flexDirection="row" gap="sm">
              <Button
                key={`toggle-${todo.id}`}
                plain
                onPress={() =>
                  changeTodos($, all => all.map(one => (one.id === todo.id ? { ...one, isDone: !one.isDone } : one)))
                }
              >
                {todo.isDone ? '☑ ' : '☐ '}
                <Text dimColor={todo.isDone}>{todo.text}</Text>
              </Button>
              <Button
                key={`del-${todo.id}`}
                plain
                label="×"
                onPress={() => changeTodos($, all => all.filter(one => one.id !== todo.id))}
              />
            </Box>
          ))}
          {done > 0 && (
            <Button
              key="aufraeumen"
              label={`Erledigte entfernen (${done})`}
              onPress={() => changeTodos($, all => all.filter(one => !one.isDone))}
            />
          )}
        </Box>
      )
    }

    const sources = [...new Set(inbox.map(message => message.source))].sort()
    const shown = inbox
      .filter(message => isAll || !message.isDone)
      .filter(message => origin === 'alle' || message.source === origin)
      .sort((a, b) => b.receivedAt - a.receivedAt)

    return (
      <Box flexDirection="column" gap="sm">
        {header}
        <Box flexDirection="row" gap="sm" flexWrap="wrap">
          {Select !== undefined && (
            <Select
              key="quelle"
              label="Quelle"
              value={origin}
              options={[{ value: 'alle', label: 'Alle' }, ...sources.map(name => ({ value: name }))]}
              onSelect={value => update($, source, () => value)}
            />
          )}
          {Select !== undefined && (
            <Select
              key="anzeige"
              label="Zeige"
              value={isAll ? 'alle' : 'offen'}
              options={[
                { value: 'offen', label: 'Offene' },
                { value: 'alle', label: 'Alle' },
              ]}
              onSelect={value => update($, showAll, () => value === 'alle')}
            />
          )}
          <Button key="abrufen" label="Abrufen" onPress={() => $.prompt.submit({ text: FETCH_PROMPT })} />
        </Box>
        {shown.length === 0 && (
          <Text dimColor>
            {inbox.length === 0
              ? 'Noch keine Nachrichten. Klick auf „Abrufen“, sobald eine Quelle wie Gmail verbunden ist.'
              : 'Keine Nachrichten in dieser Ansicht.'}
          </Text>
        )}
        {shown.map(message => (
          <Box flexDirection="column">
            <Button
              key={`msg-${message.id}`}
              plain
              onPress={() => update($, openId, id => (id === message.id ? '' : message.id))}
            >
              {message.isDone ? '✓ ' : '● '}
              {message.from}
              <Text dimColor>
                {' '}
                · {message.source} · {when(message.receivedAt, now)}
              </Text>
            </Button>
            <Text dimColor>{message.subject === '' ? message.text.slice(0, 80) : message.subject}</Text>
            {opened === message.id && (
              <Box flexDirection="column" gap="xs" paddingLeft={2}>
                <Text>{message.text}</Text>
                <Box flexDirection="row" gap="sm" flexWrap="wrap">
                  <Button key={`reply-${message.id}`} variant="primary" label="Antworten" onPress={() => draftReply($, message)} />
                  <Button
                    key={`todo-${message.id}`}
                    label="Als To-do"
                    onPress={() => addTodos($, [`Antworten: ${message.from}${message.subject === '' ? '' : ` – ${message.subject}`}`])}
                  />
                  <Button
                    key={`done-${message.id}`}
                    label={message.isDone ? 'Wieder offen' : 'Erledigt'}
                    onPress={() =>
                      changeMessages($, all => all.map(one => (one.id === message.id ? { ...one, isDone: !one.isDone } : one)))
                    }
                  />
                  <Button
                    key={`drop-${message.id}`}
                    label="Löschen"
                    onPress={() => changeMessages($, all => all.filter(one => one.id !== message.id))}
                  />
                </Box>
              </Box>
            )}
          </Box>
        ))}
      </Box>
    )
  })
}
