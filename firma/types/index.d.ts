export type Model = 'haiku' | 'sonnet'

export type Hire = {
  id: string
  name: string
  description: string
  prompt: string
  model: Model
  tools: string[]
  hiredAt: number
}

declare module 'claude-code' {
  interface PluginState {
    firma: {
      kosten: Shaped<Record<string, number>>
      einsaetze: Shaped<Record<string, number>>
      laufend: string[]
      bericht: string
      personal: Shaped<Hire[]>
    }
  }
}
