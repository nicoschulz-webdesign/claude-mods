export type Todo = { id: string; text: string; isDone: boolean; createdAt: number }

export type Message = {
  id: string
  source: string
  from: string
  subject: string
  text: string
  receivedAt: number
  isDone: boolean
}

export type Tab = 'todos' | 'nachrichten'

declare module 'claude-code' {
  interface PluginState {
    dashboard: {
      todos: Shaped<Todo[]>
      messages: Shaped<Message[]>
      tab: Tab
      showAll: boolean
      source: string
      openId: string
    }
  }
}
