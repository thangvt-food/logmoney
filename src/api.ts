import type { Expense, Profile } from './types'

export type McpTokenInfo = { id: string; label: string; createdAt: string }
export type CreatedMcpToken = { token: string; tokenInfo: McpTokenInfo }

const expensesKey = 'logmoney.expenses.v1'
const profileKey = 'logmoney.profile.v1'
const apiBaseUrl = import.meta.env.VITE_API_BASE_URL?.replace(/\/+$/, '') ?? ''

const seedExpenses: Expense[] = [
  { id: 'seed-1', title: 'Cà phê sáng', amount: 65000, category: 'Ăn uống', date: new Date().toISOString().slice(0, 10) },
  { id: 'seed-2', title: 'Gửi xe', amount: 15000, category: 'Di chuyển', date: new Date().toISOString().slice(0, 10) },
  { id: 'seed-3', title: 'Đi chợ cuối tuần', amount: 325000, category: 'Nhà cửa', date: new Date(Date.now() - 86400000).toISOString().slice(0, 10) },
  { id: 'seed-4', title: 'Ăn trưa với team', amount: 145000, category: 'Ăn uống', date: new Date(Date.now() - 86400000 * 2).toISOString().slice(0, 10) },
  { id: 'seed-5', title: 'Vé xem phim', amount: 180000, category: 'Giải trí', date: new Date(Date.now() - 86400000 * 3).toISOString().slice(0, 10) },
  { id: 'seed-6', title: 'Grab đi làm', amount: 48000, category: 'Di chuyển', date: new Date(Date.now() - 86400000 * 4).toISOString().slice(0, 10) },
]

function localExpenses(): Expense[] {
  const stored = localStorage.getItem(expensesKey)
  if (!stored) {
    localStorage.setItem(expensesKey, JSON.stringify(seedExpenses))
    return seedExpenses
  }
  return JSON.parse(stored) as Expense[]
}

function localProfile(): Profile {
  const stored = localStorage.getItem(profileKey)
  if (!stored) {
    const initial = { monthlyBudget: 12000000 }
    localStorage.setItem(profileKey, JSON.stringify(initial))
    return initial
  }
  return JSON.parse(stored) as Profile
}

async function request<T>(path: string, token: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(`${apiBaseUrl}/api${path}`, {
    ...options,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...options.headers },
  })
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { error?: string }
    throw new Error(body.error || `Yêu cầu thất bại (${response.status}).`)
  }
  return response.json() as Promise<T>
}

export async function getExpenses(token?: string): Promise<Expense[]> {
  if (!token) return localExpenses()
  return (await request<{ expenses: Expense[] }>('/expenses', token)).expenses
}

export async function addExpense(expense: Omit<Expense, 'id'>, token?: string): Promise<Expense> {
  if (token) return (await request<{ expense: Expense }>('/expenses', token, { method: 'POST', body: JSON.stringify(expense) })).expense
  const next = { ...expense, id: crypto.randomUUID() }
  localStorage.setItem(expensesKey, JSON.stringify([next, ...localExpenses()]))
  return next
}

export async function removeExpense(id: string, token?: string): Promise<void> {
  if (token) {
    await request(`/expenses/${encodeURIComponent(id)}`, token, { method: 'DELETE' })
    return
  }
  localStorage.setItem(expensesKey, JSON.stringify(localExpenses().filter((expense) => expense.id !== id)))
}

export async function getProfile(token?: string): Promise<Profile> {
  if (!token) return localProfile()
  return (await request<{ profile: Profile }>('/profile', token)).profile
}

export async function updateBudget(monthlyBudget: number, token?: string): Promise<Profile> {
  if (token) {
    return (await request<{ profile: Profile }>('/profile', token, { method: 'PUT', body: JSON.stringify({ monthlyBudget }) })).profile
  }
  const profile = { monthlyBudget }
  localStorage.setItem(profileKey, JSON.stringify(profile))
  return profile
}

export async function getMcpTokens(token: string): Promise<McpTokenInfo[]> {
  return (await request<{ tokens: McpTokenInfo[] }>('/mcp-tokens', token)).tokens
}

export async function createMcpToken(label: string, token: string): Promise<CreatedMcpToken> {
  return request<CreatedMcpToken>('/mcp-tokens', token, { method: 'POST', body: JSON.stringify({ label }) })
}

export async function revokeMcpToken(id: string, token: string): Promise<void> {
  await request(`/mcp-tokens/${encodeURIComponent(id)}`, token, { method: 'DELETE' })
}
