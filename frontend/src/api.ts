export interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
  // A data: URI on a just-attached/temporary-chat message, or the served
  // /api/uploads/... path once a saved conversation reloads it from disk —
  // either way it's a valid <img src>. Display only — never resent to the
  // backend on later turns.
  image?: string
  // The model's own detailed description of `image`, computed once via
  // describeImage() right when it's attached. This is what actually gets
  // sent on every turn instead of the image bytes — see backend/chat.ts.
  imageDescription?: string
}

export async function describeImage(imageDataUrl: string): Promise<string> {
  const res = await fetch('/api/chat/describe-image', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ image: imageDataUrl }),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }))
    throw new Error(err.error || "Erreur d'analyse de l'image")
  }
  const data = await res.json()
  return data.description as string
}

export async function sendChat(payload: {
  conversationId?: number
  message?: string
  messages?: ChatMessage[]
  image?: string
  imageDescription?: string
}): Promise<string> {
  const res = await fetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }))
    throw new Error(err.error || 'Erreur chat')
  }
  const data = await res.json()
  return data.reply as string
}

export interface Conversation {
  id: number
  title: string
  created_at: string
  updated_at: string
}

export async function fetchConversations(): Promise<Conversation[]> {
  const res = await fetch('/api/conversations')
  if (!res.ok) throw new Error('Erreur chargement conversations')
  return res.json()
}

export async function createConversation(): Promise<{ id: number }> {
  const res = await fetch('/api/conversations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  })
  if (!res.ok) throw new Error('Erreur création conversation')
  return res.json()
}

export async function fetchConversationMessages(id: number): Promise<ChatMessage[]> {
  const res = await fetch(`/api/conversations/${id}/messages`)
  if (!res.ok) throw new Error('Erreur chargement messages')
  return res.json()
}

export async function deleteConversation(id: number): Promise<void> {
  const res = await fetch(`/api/conversations/${id}`, { method: 'DELETE' })
  if (!res.ok) throw new Error('Erreur suppression conversation')
}

export interface BudgetCategory {
  category: string
  spent: number
  limit: number | null
}

export interface BudgetSummary {
  month: string
  categories: BudgetCategory[]
  incomeCategories: BudgetCategory[]
  totalIncome: number
  totalSpent: number
  balance: number
}

export async function fetchBudgetSummary(month?: string): Promise<BudgetSummary> {
  const url = month ? `/api/budget/summary?month=${month}` : '/api/budget/summary'
  const res = await fetch(url)
  if (!res.ok) throw new Error('Erreur chargement budget')
  return res.json()
}

export interface NewTransaction {
  date: string // YYYY-MM-DD
  label: string
  amount: number
  category?: string
}

export async function createTransaction(tx: NewTransaction): Promise<{ id: number; category: string }> {
  const res = await fetch('/api/transactions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(tx),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }))
    throw new Error(err.error || "Erreur d'ajout")
  }
  return res.json()
}

export interface Transaction {
  id: number
  date: string
  label: string
  amount: number
  category: string
}

export async function fetchTransactions(opts: { month?: string; category?: string; limit?: number }): Promise<Transaction[]> {
  const params = new URLSearchParams()
  if (opts.month) params.set('month', opts.month)
  if (opts.category) params.set('category', opts.category)
  if (opts.limit) params.set('limit', String(opts.limit))
  const res = await fetch(`/api/transactions?${params.toString()}`)
  if (!res.ok) throw new Error('Erreur chargement transactions')
  return res.json()
}

export async function updateTransactionCategory(id: number, category: string): Promise<{ ok: boolean; learnedKeyword: string | null }> {
  const res = await fetch(`/api/transactions/${id}/category`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ category }),
  })
  if (!res.ok) throw new Error('Erreur mise à jour catégorie')
  return res.json()
}

export interface Envelope {
  id: number
  name: string
  category: string
  total_amount: number
  period_start: string
  period_end: string
  spent: number
  remaining: number
  percentUsed: number
  daysRemaining: number
  projectedTotal: number
  onTrack: boolean
}

export async function fetchEnvelopes(): Promise<Envelope[]> {
  const res = await fetch('/api/envelope')
  if (!res.ok) throw new Error('Erreur chargement enveloppe')
  return res.json()
}

export async function updateEnvelope(
  id: number,
  patch: { totalAmount?: number; periodStart?: string; periodEnd?: string }
): Promise<Envelope> {
  const res = await fetch(`/api/envelope/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  })
  if (!res.ok) throw new Error('Erreur mise à jour enveloppe')
  return res.json()
}

export type GoalKind = 'unique' | 'recurrent'
export type GoalStatus = 'a_faire' | 'en_cours' | 'fait' | 'abandonne'

export interface Goal {
  id: number
  title: string
  description: string | null
  kind: GoalKind
  target_date: string | null
  status: GoalStatus
  completed_at: string | null
  checkinCount: number
  lastCheckin: string | null
  checkedInToday: boolean
  streak: number
  last7Days: boolean[]
}

export async function fetchGoals(): Promise<Goal[]> {
  const res = await fetch('/api/goals')
  if (!res.ok) throw new Error('Erreur chargement objectifs')
  return res.json()
}

export async function createGoal(goal: {
  title: string
  description?: string
  kind: GoalKind
  targetDate?: string
}): Promise<{ id: number }> {
  const res = await fetch('/api/goals', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(goal),
  })
  if (!res.ok) throw new Error("Erreur création objectif")
  return res.json()
}

export async function updateGoal(
  id: number,
  patch: { status?: GoalStatus; title?: string; description?: string; targetDate?: string }
): Promise<void> {
  const res = await fetch(`/api/goals/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  })
  if (!res.ok) throw new Error('Erreur mise à jour objectif')
}

export async function deleteGoal(id: number): Promise<void> {
  const res = await fetch(`/api/goals/${id}`, { method: 'DELETE' })
  if (!res.ok) throw new Error('Erreur suppression objectif')
}

export async function checkInGoal(id: number, note?: string): Promise<void> {
  const res = await fetch(`/api/goals/${id}/checkins`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ note }),
  })
  if (!res.ok) throw new Error('Erreur enregistrement')
}

export async function uncheckInGoal(id: number, date: string): Promise<void> {
  const res = await fetch(`/api/goals/${id}/checkins/${date}`, { method: 'DELETE' })
  if (!res.ok) throw new Error('Erreur suppression')
}

export interface RaceLog {
  id: number
  date: string
  event: string
  type: string
  quali_position: number | null
  quali_chrono: number | null
  course_chrono: number | null
  position_finale: number | null
  chrono_vainqueur: number | null
  ecart_leader: number | null
  notes: string | null
}

export async function fetchRaces(): Promise<RaceLog[]> {
  const res = await fetch('/api/races')
  if (!res.ok) throw new Error('Erreur chargement courses')
  return res.json()
}

export async function createRace(race: {
  date: string
  event: string
  type: string
  qualiPosition?: number
  qualiChrono?: number
  courseChrono?: number
  positionFinale?: number
  chronoVainqueur?: number
  ecartLeader?: number
  notes?: string
}): Promise<{ id: number }> {
  const res = await fetch('/api/races', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(race),
  })
  if (!res.ok) throw new Error("Erreur enregistrement course")
  return res.json()
}

export async function updateRace(
  id: number,
  race: {
    date: string
    event: string
    type: string
    qualiPosition?: number
    qualiChrono?: number
    courseChrono?: number
    positionFinale?: number
    chronoVainqueur?: number
    ecartLeader?: number
    notes?: string
  }
): Promise<void> {
  const res = await fetch(`/api/races/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(race),
  })
  if (!res.ok) throw new Error('Erreur modification course')
}

export async function deleteRace(id: number): Promise<void> {
  const res = await fetch(`/api/races/${id}`, { method: 'DELETE' })
  if (!res.ok) throw new Error('Erreur suppression course')
}

export interface Todo {
  id: number
  title: string
  done: boolean
  created_at: string
  completed_at: string | null
}

export async function fetchTodos(): Promise<Todo[]> {
  const res = await fetch('/api/todos')
  if (!res.ok) throw new Error('Erreur chargement todo')
  return res.json()
}

export async function createTodo(title: string): Promise<{ id: number }> {
  const res = await fetch('/api/todos', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title }),
  })
  if (!res.ok) throw new Error("Erreur d'ajout")
  return res.json()
}

export async function updateTodo(id: number, patch: { done?: boolean; title?: string }): Promise<void> {
  const res = await fetch(`/api/todos/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  })
  if (!res.ok) throw new Error('Erreur mise à jour')
}

export async function deleteTodo(id: number): Promise<void> {
  const res = await fetch(`/api/todos/${id}`, { method: 'DELETE' })
  if (!res.ok) throw new Error('Erreur suppression')
}

export interface Aspsp {
  name: string
  country: string
  logo?: string
  bic?: string
}

export async function fetchAspsps(country = 'FR'): Promise<Aspsp[]> {
  const res = await fetch(`/api/banksync/aspsps?country=${country}`)
  if (!res.ok) throw new Error('Erreur chargement banques')
  return res.json()
}

export async function connectBank(aspspName: string, aspspCountry: string): Promise<{ url: string }> {
  const res = await fetch('/api/banksync/connect', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ aspspName, aspspCountry }),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }))
    throw new Error(err.error || 'Erreur connexion banque')
  }
  return res.json()
}

export interface BankAccount {
  id: number
  uid: string
  iban: string | null
  name: string | null
  last_synced_at: string | null
}

export interface BankConnection {
  id: number
  aspsp_name: string
  aspsp_country: string
  valid_until: string | null
  created_at: string
  accounts: BankAccount[]
}

export async function fetchBankConnections(): Promise<BankConnection[]> {
  const res = await fetch('/api/banksync/connections')
  if (!res.ok) throw new Error('Erreur chargement connexions bancaires')
  return res.json()
}

export async function disconnectBank(id: number): Promise<void> {
  const res = await fetch(`/api/banksync/connections/${id}`, { method: 'DELETE' })
  if (!res.ok) throw new Error('Erreur déconnexion')
}

export async function importBankTransactions(connectionId: number): Promise<{ imported: number }> {
  const res = await fetch(`/api/banksync/connections/${connectionId}/import`, { method: 'POST' })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }))
    throw new Error(err.error || "Erreur d'import")
  }
  return res.json()
}

export async function importCsv(file: File): Promise<{ imported: number }> {
  const formData = new FormData()
  formData.append('file', file)
  const res = await fetch('/api/transactions/import', {
    method: 'POST',
    body: formData,
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }))
    throw new Error(err.error || "Erreur d'import")
  }
  return res.json()
}
