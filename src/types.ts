export type Source = "claude-code" | "opencode"

export interface Session {
  id: string
  source: Source
  directory: string
  branch: string | null
  title: string
  parentId: string | null
  startedAt: number
  lastAt: number
  messageCount: number
}

export interface Message {
  sessionId: string
  role: "user" | "assistant"
  content: string
  timestamp: number
  position: number
}

export interface SearchHit {
  session: Session
  snippet: string
  position: number
  role: "user" | "assistant"
  timestamp: number
}

export interface SessionStats {
  model: string
  turns: number
  outputTokens: number
  cacheRead: number
  cacheWrite: number
}

export interface DailyActivity {
  day: string
  sessions: number
  userMsgs: number
  assistantTurns: number
}
