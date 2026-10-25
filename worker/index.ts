import { createRemoteJWKSet, importPKCS8, jwtVerify, SignJWT } from 'jose'

interface Env {
  FIREBASE_PROJECT_ID: string
  SERVICE_ACCOUNT_JSON: string
  ALLOWED_ORIGIN: string
  MCP_TEST_TOKEN?: string
}

interface Expense {
  id: string
  title: string
  amount: number
  category: string
  date: string
  note?: string
}

const firebaseKeys = createRemoteJWKSet(new URL('https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com'))
const firestoreScopes = 'https://www.googleapis.com/auth/datastore'
const firestoreBase = (projectId: string) => `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/databases/(default)/documents`
const appRoot = 'apps/logmoney'
let cachedAccessToken: { value: string; expiresAt: number } | undefined

function respond(body: unknown, status: number, origin: string): Response {
  return Response.json(body, {
    status,
    headers: {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type',
      'Vary': 'Origin',
    },
  })
}

function fieldsToObject(fields: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(fields).map(([key, value]) => {
    if (!value || typeof value !== 'object') return [key, value]
    const field = value as Record<string, unknown>
    if ('stringValue' in field) return [key, field.stringValue]
    if ('integerValue' in field) return [key, Number(field.integerValue)]
    if ('doubleValue' in field) return [key, Number(field.doubleValue)]
    if ('booleanValue' in field) return [key, field.booleanValue]
    return [key, null]
  }))
}

function objectToFields(value: object): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).map(([key, item]) => {
    if (typeof item === 'string') return [key, { stringValue: item }]
    if (typeof item === 'number' && Number.isInteger(item)) return [key, { integerValue: String(item) }]
    if (typeof item === 'number') return [key, { doubleValue: item }]
    if (typeof item === 'boolean') return [key, { booleanValue: item }]
    return [key, { nullValue: null }]
  }))
}

function collectionPath(uid: string): string {
  return `${appRoot}/users/${encodeURIComponent(uid)}`
}

function tokenIndexPath(tokenHash: string): string {
  return `${appRoot}/mcpTokens/${tokenHash}`
}

async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

function constantTimeEqual(left: string, right: string): boolean {
  let difference = left.length ^ right.length
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    difference |= (left.charCodeAt(index % (left.length || 1)) || 0) ^ (right.charCodeAt(index % (right.length || 1)) || 0)
  }
  return difference === 0
}

async function getFirestoreToken(env: Env): Promise<string> {
  if (cachedAccessToken && cachedAccessToken.expiresAt > Date.now() + 60_000) return cachedAccessToken.value
  const serviceAccount = JSON.parse(env.SERVICE_ACCOUNT_JSON) as { client_email: string; private_key: string; project_id: string }
  if (serviceAccount.project_id !== env.FIREBASE_PROJECT_ID || !serviceAccount.client_email || !serviceAccount.private_key) {
    throw new Error('Service account does not match the configured Firebase project.')
  }
  const key = await importPKCS8(serviceAccount.private_key, 'RS256')
  const assertion = await new SignJWT({ scope: firestoreScopes })
    .setProtectedHeader({ alg: 'RS256', typ: 'JWT' })
    .setIssuer(serviceAccount.client_email)
    .setSubject(serviceAccount.client_email)
    .setAudience('https://oauth2.googleapis.com/token')
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(key)
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
  })
  if (!response.ok) throw new Error(`Google service-account token request failed (${response.status}).`)
  const result = await response.json() as { access_token: string; expires_in: number }
  cachedAccessToken = { value: result.access_token, expiresAt: Date.now() + result.expires_in * 1000 }
  return result.access_token
}

async function firestore(env: Env, path: string, init: RequestInit = {}): Promise<Response> {
  const token = await getFirestoreToken(env)
  return fetch(`${firestoreBase(env.FIREBASE_PROJECT_ID)}/${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...init.headers },
  })
}

async function firestoreError(response: Response, operation: string): Promise<string> {
  const body = await response.json().catch(() => null) as { error?: { message?: string; status?: string } } | null
  const status = body?.error?.status ?? `HTTP_${response.status}`
  const message = body?.error?.message ?? 'Firestore did not provide an error message.'
  console.error(`Firestore ${operation} failed (${response.status} ${status}): ${message}`)
  return `Firestore từ chối thao tác (${status}): ${message}`
}

async function copyLegacyCollection(
  env: Env,
  legacyPath: string,
  targetPath: string,
  onCopied?: (documentId: string, fields: Record<string, unknown>) => Promise<void>,
): Promise<void> {
  let pageToken: string | undefined
  do {
    const query = new URLSearchParams({ pageSize: '1000' })
    if (pageToken) query.set('pageToken', pageToken)
    const result = await firestore(env, `${legacyPath}?${query}`)
    if (result.status === 404) return
    if (!result.ok) throw new Error(await firestoreError(result, 'read legacy data'))
    const data = await result.json() as { documents?: Array<{ name: string; fields?: Record<string, unknown> }>; nextPageToken?: string }
    for (const document of data.documents ?? []) {
      const documentId = document.name.split('/').at(-1)
      if (!documentId) throw new Error('Firestore returned an invalid legacy document path.')
      const fields = document.fields ?? {}
      const copied = await firestore(env, `${targetPath}?documentId=${encodeURIComponent(documentId)}`, {
        method: 'POST',
        body: JSON.stringify({ fields }),
      })
      if (!copied.ok && copied.status !== 409) throw new Error(await firestoreError(copied, 'copy legacy data'))
      if (onCopied) await onCopied(documentId, fields)
    }
    pageToken = data.nextPageToken
  } while (pageToken)
}

async function ensureLogmoneyNamespace(env: Env, uid: string): Promise<void> {
  const targetRoot = collectionPath(uid)
  const targetResult = await firestore(env, targetRoot)
  if (!targetResult.ok && targetResult.status !== 404) throw new Error(await firestoreError(targetResult, 'check app namespace'))
  if (targetResult.ok) {
    const targetDocument = await targetResult.json() as { fields?: Record<string, unknown> }
    if (fieldsToObject(targetDocument.fields ?? {}).logmoneyNamespaceVersion === 1) return
  }

  const legacyRoot = `users/${encodeURIComponent(uid)}`
  const legacyProfileResult = await firestore(env, legacyRoot)
  let legacyFields: Record<string, unknown> = {}
  if (legacyProfileResult.ok) {
    const legacyProfile = await legacyProfileResult.json() as { fields?: Record<string, unknown> }
    legacyFields = legacyProfile.fields ?? {}
  } else if (legacyProfileResult.status !== 404) {
    throw new Error(await firestoreError(legacyProfileResult, 'read legacy profile'))
  }

  if (targetResult.status === 404) {
    const rootCreated = await firestore(env, `${appRoot}/users?documentId=${encodeURIComponent(uid)}`, {
      method: 'POST',
      body: JSON.stringify({ fields: { ...legacyFields, logmoneyNamespaceVersion: { integerValue: '1' } } }),
    })
    if (!rootCreated.ok && rootCreated.status !== 409) throw new Error(await firestoreError(rootCreated, 'create app namespace'))
  }

  await copyLegacyCollection(env, `${legacyRoot}/expenses`, `${targetRoot}/expenses`)
  await copyLegacyCollection(env, `${legacyRoot}/mcpTokens`, `${targetRoot}/mcpTokens`, async (documentId, fields) => {
    const indexCreated = await firestore(env, `${appRoot}/mcpTokens?documentId=${encodeURIComponent(documentId)}`, {
      method: 'POST',
      body: JSON.stringify({ fields: { uid: fields.uid ?? { stringValue: uid } } }),
    })
    if (!indexCreated.ok && indexCreated.status !== 409) throw new Error(await firestoreError(indexCreated, 'copy legacy MCP token index'))
  })

  const marked = await firestore(env, `${targetRoot}?updateMask.fieldPaths=logmoneyNamespaceVersion`, {
    method: 'PATCH',
    body: JSON.stringify({ fields: { logmoneyNamespaceVersion: { integerValue: '1' } } }),
  })
  if (!marked.ok) throw new Error(await firestoreError(marked, 'mark app namespace migration'))
}

function validExpense(value: unknown): value is Omit<Expense, 'id'> {
  if (!value || typeof value !== 'object') return false
  const body = value as Record<string, unknown>
  return typeof body.title === 'string' && body.title.trim().length > 0 && body.title.length <= 80
    && typeof body.amount === 'number' && Number.isSafeInteger(body.amount) && body.amount > 0 && body.amount <= 1_000_000_000_000
    && ['Ăn uống', 'Di chuyển', 'Mua sắm', 'Nhà cửa', 'Giải trí', 'Sức khỏe', 'Khác'].includes(String(body.category))
    && typeof body.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(body.date)
    && (body.note === undefined || (typeof body.note === 'string' && body.note.length <= 160))
}

async function readExpenses(env: Env, uid: string): Promise<Expense[]> {
  const result = await firestore(env, `${collectionPath(uid)}/expenses?pageSize=1000&orderBy=date%20desc`)
  if (!result.ok) throw new Error(await firestoreError(result, 'list expenses'))
  const data = await result.json() as { documents?: Array<{ name: string; fields?: Record<string, unknown> }> }
  return (data.documents ?? []).map((document) => ({
    ...fieldsToObject(document.fields ?? {}),
    id: document.name.split('/').at(-1),
  }) as Expense)
}

async function writeExpense(env: Env, uid: string, expense: Omit<Expense, 'id'>): Promise<Expense> {
  const id = crypto.randomUUID()
  const result = await firestore(env, `${collectionPath(uid)}/expenses?documentId=${id}`, {
    method: 'POST',
    body: JSON.stringify({ fields: objectToFields(expense) }),
  })
  if (!result.ok) throw new Error(await firestoreError(result, 'create expense'))
  return { ...expense, id }
}

async function readProfile(env: Env, uid: string): Promise<{ monthlyBudget: number }> {
  const result = await firestore(env, collectionPath(uid))
  if (result.status === 404) return { monthlyBudget: 12_000_000 }
  if (!result.ok) throw new Error(await firestoreError(result, 'get profile'))
  const data = await result.json() as { fields?: Record<string, unknown> }
  const profile = fieldsToObject(data.fields ?? {})
  return { monthlyBudget: typeof profile.monthlyBudget === 'number' ? profile.monthlyBudget : 12_000_000 }
}

async function writeBudget(env: Env, uid: string, monthlyBudget: number): Promise<void> {
  const result = await firestore(env, `${collectionPath(uid)}?updateMask.fieldPaths=monthlyBudget`, {
    method: 'PATCH',
    body: JSON.stringify({ fields: objectToFields({ monthlyBudget }) }),
  })
  if (!result.ok) throw new Error(await firestoreError(result, 'update profile'))
}

async function route(request: Request, env: Env, uid: string): Promise<Response> {
  const url = new URL(request.url)
  const root = collectionPath(uid)
  const expenseCollection = `${root}/expenses`

  if (request.method === 'GET' && url.pathname === '/api/mcp-tokens') {
    const result = await firestore(env, `${root}/mcpTokens?pageSize=100`)
    if (!result.ok) return respond({ error: await firestoreError(result, 'list MCP tokens') }, 502, env.ALLOWED_ORIGIN)
    const data = await result.json() as { documents?: Array<{ name: string; fields?: Record<string, unknown> }> }
    const tokens = (data.documents ?? []).map((document) => ({
      id: document.name.split('/').at(-1),
      ...fieldsToObject(document.fields ?? {}),
    }))
    return respond({ tokens }, 200, env.ALLOWED_ORIGIN)
  }

  if (request.method === 'POST' && url.pathname === '/api/mcp-tokens') {
    const body: unknown = await request.json().catch(() => null)
    const label = body && typeof body === 'object' ? (body as Record<string, unknown>).label : undefined
    if (typeof label !== 'string' || !label.trim() || label.length > 60) {
      return respond({ error: 'Tên token cần có từ 1 đến 60 ký tự.' }, 400, env.ALLOWED_ORIGIN)
    }
    const random = crypto.getRandomValues(new Uint8Array(32))
    const token = `lmcp_${Array.from(random, (byte) => byte.toString(16).padStart(2, '0')).join('')}`
    const id = await hashToken(token)
    const createdAt = new Date().toISOString()
    const tokenFields = objectToFields({ uid, label: label.trim(), createdAt })
    const indexResult = await firestore(env, `${appRoot}/mcpTokens?documentId=${id}`, {
      method: 'POST',
      body: JSON.stringify({ fields: objectToFields({ uid }) }),
    })
    if (!indexResult.ok) return respond({ error: await firestoreError(indexResult, 'create MCP token') }, 502, env.ALLOWED_ORIGIN)
    const metadataResult = await firestore(env, `${root}/mcpTokens?documentId=${id}`, {
      method: 'POST',
      body: JSON.stringify({ fields: tokenFields }),
    })
    if (!metadataResult.ok) {
      await firestore(env, tokenIndexPath(id), { method: 'DELETE' })
      return respond({ error: await firestoreError(metadataResult, 'save MCP token metadata') }, 502, env.ALLOWED_ORIGIN)
    }
    return respond({ token, tokenInfo: { id, label: label.trim(), createdAt } }, 201, env.ALLOWED_ORIGIN)
  }

  const tokenMatch = url.pathname.match(/^\/api\/mcp-tokens\/([a-f0-9]{64})$/)
  if (tokenMatch && request.method === 'DELETE') {
    const indexResult = await firestore(env, tokenIndexPath(tokenMatch[1]))
    if (indexResult.status === 404) return respond({ error: 'Không tìm thấy token.' }, 404, env.ALLOWED_ORIGIN)
    if (!indexResult.ok) return respond({ error: await firestoreError(indexResult, 'verify MCP token') }, 502, env.ALLOWED_ORIGIN)
    const index = await indexResult.json() as { fields?: Record<string, unknown> }
    if (fieldsToObject(index.fields ?? {}).uid !== uid) return respond({ error: 'Không tìm thấy token.' }, 404, env.ALLOWED_ORIGIN)
    const metadataResult = await firestore(env, `${root}/mcpTokens/${tokenMatch[1]}`, { method: 'DELETE' })
    if (!metadataResult.ok && metadataResult.status !== 404) return respond({ error: await firestoreError(metadataResult, 'revoke MCP token metadata') }, 502, env.ALLOWED_ORIGIN)
    const deleteResult = await firestore(env, tokenIndexPath(tokenMatch[1]), { method: 'DELETE' })
    if (!deleteResult.ok && deleteResult.status !== 404) return respond({ error: await firestoreError(deleteResult, 'revoke MCP token') }, 502, env.ALLOWED_ORIGIN)
    return respond({ ok: true }, 200, env.ALLOWED_ORIGIN)
  }

  if (request.method === 'GET' && url.pathname === '/api/expenses') {
    const result = await firestore(env, `${expenseCollection}?pageSize=1000&orderBy=date%20desc`)
    if (!result.ok) return respond({ error: await firestoreError(result, 'list expenses') }, 502, env.ALLOWED_ORIGIN)
    const data = await result.json() as { documents?: Array<{ name: string; fields?: Record<string, unknown> }> }
    const expenses = (data.documents ?? []).map((document) => ({
      ...fieldsToObject(document.fields ?? {}),
      id: document.name.split('/').at(-1),
    }))
    return respond({ expenses }, 200, env.ALLOWED_ORIGIN)
  }

  if (request.method === 'POST' && url.pathname === '/api/expenses') {
    const body: unknown = await request.json().catch(() => null)
    if (!validExpense(body)) return respond({ error: 'Thông tin khoản chi không hợp lệ.' }, 400, env.ALLOWED_ORIGIN)
    const id = crypto.randomUUID()
    const result = await firestore(env, `${expenseCollection}?documentId=${id}`, {
      method: 'POST', body: JSON.stringify({ fields: objectToFields(body as Record<string, unknown>) }),
    })
    if (!result.ok) return respond({ error: await firestoreError(result, 'create expense') }, 502, env.ALLOWED_ORIGIN)
    return respond({ expense: { ...body, id } }, 201, env.ALLOWED_ORIGIN)
  }

  const expenseMatch = url.pathname.match(/^\/api\/expenses\/([A-Za-z0-9_-]+)$/)
  if (expenseMatch && request.method === 'DELETE') {
    const result = await firestore(env, `${expenseCollection}/${encodeURIComponent(expenseMatch[1])}`, { method: 'DELETE' })
    if (!result.ok && result.status !== 404) return respond({ error: await firestoreError(result, 'delete expense') }, 502, env.ALLOWED_ORIGIN)
    return respond({ ok: true }, 200, env.ALLOWED_ORIGIN)
  }

  const profilePath = root
  if (url.pathname === '/api/profile' && request.method === 'GET') {
    const result = await firestore(env, profilePath)
    if (result.status === 404) return respond({ profile: { monthlyBudget: 12_000_000 } }, 200, env.ALLOWED_ORIGIN)
    if (!result.ok) return respond({ error: await firestoreError(result, 'get profile') }, 502, env.ALLOWED_ORIGIN)
    const data = await result.json() as { fields?: Record<string, unknown> }
    return respond({ profile: fieldsToObject(data.fields ?? {}) }, 200, env.ALLOWED_ORIGIN)
  }

  if (url.pathname === '/api/profile' && request.method === 'PUT') {
    const body: unknown = await request.json().catch(() => null)
    const monthlyBudget = body && typeof body === 'object' ? (body as Record<string, unknown>).monthlyBudget : undefined
    if (typeof monthlyBudget !== 'number' || !Number.isSafeInteger(monthlyBudget) || monthlyBudget <= 0 || monthlyBudget > 1_000_000_000_000) {
      return respond({ error: 'Ngân sách không hợp lệ.' }, 400, env.ALLOWED_ORIGIN)
    }
    const result = await firestore(env, `${profilePath}?updateMask.fieldPaths=monthlyBudget`, {
      method: 'PATCH',
      body: JSON.stringify({ fields: objectToFields({ monthlyBudget }) }),
    })
    if (!result.ok) return respond({ error: await firestoreError(result, 'update profile') }, 502, env.ALLOWED_ORIGIN)
    return respond({ profile: { monthlyBudget } }, 200, env.ALLOWED_ORIGIN)
  }

  return respond({ error: 'Không tìm thấy đường dẫn.' }, 404, env.ALLOWED_ORIGIN)
}

const mcpTools = [
  {
    name: 'list_expenses',
    description: 'List the signed-in user’s expenses, optionally filtered by date range and category.',
    inputSchema: {
      type: 'object',
      properties: {
        startDate: { type: 'string', description: 'Inclusive date in YYYY-MM-DD format.' },
        endDate: { type: 'string', description: 'Inclusive date in YYYY-MM-DD format.' },
        category: { type: 'string', enum: ['Ăn uống', 'Di chuyển', 'Mua sắm', 'Nhà cửa', 'Giải trí', 'Sức khỏe', 'Khác'] },
        limit: { type: 'integer', minimum: 1, maximum: 100 },
      },
    },
  },
  {
    name: 'get_spending_summary',
    description: 'Summarize expense total and totals by category for a date range. Defaults to the current calendar month.',
    inputSchema: {
      type: 'object',
      properties: {
        startDate: { type: 'string', description: 'Inclusive date in YYYY-MM-DD format.' },
        endDate: { type: 'string', description: 'Inclusive date in YYYY-MM-DD format.' },
      },
    },
  },
  {
    name: 'get_budget',
    description: 'Get monthly budget, month-to-date spending, remaining monthly amount, and the proportional daily allowance.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'create_expense',
    description: 'Add an expense to the signed-in user’s ledger.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', minLength: 1, maxLength: 80 },
        amount: { type: 'integer', minimum: 1, description: 'Amount in VND.' },
        category: { type: 'string', enum: ['Ăn uống', 'Di chuyển', 'Mua sắm', 'Nhà cửa', 'Giải trí', 'Sức khỏe', 'Khác'] },
        date: { type: 'string', description: 'Date in YYYY-MM-DD format.' },
        note: { type: 'string', maxLength: 160 },
      },
      required: ['title', 'amount', 'category', 'date'],
    },
  },
  {
    name: 'delete_expense',
    description: 'Permanently delete one expense by its ID. Confirm with the user before deleting.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Expense ID returned by list_expenses.' } },
      required: ['id'],
    },
  },
  {
    name: 'set_monthly_budget',
    description: 'Set the signed-in user’s monthly budget in VND.',
    inputSchema: {
      type: 'object',
      properties: { monthlyBudget: { type: 'integer', minimum: 1, maximum: 1000000000000 } },
      required: ['monthlyBudget'],
    },
  },
]

type McpRequest = { jsonrpc: '2.0'; id?: string | number | null; method?: string; params?: Record<string, unknown> }

function mcpResult(id: string | number | null, result: unknown): Response {
  return Response.json({ jsonrpc: '2.0', id, result }, { headers: { 'Content-Type': 'application/json' } })
}

function mcpError(id: string | number | null, code: number, message: string): Response {
  return Response.json({ jsonrpc: '2.0', id, error: { code, message } }, { headers: { 'Content-Type': 'application/json' } })
}

function toolResult(value: unknown, isError = false): { content: Array<{ type: 'text'; text: string }>; isError?: boolean } {
  return { content: [{ type: 'text', text: JSON.stringify(value) }], ...(isError ? { isError: true } : {}) }
}

function isDateString(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const date = new Date(`${value}T00:00:00.000Z`)
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value
}

async function runMcpTool(
  env: Env,
  uid: string,
  isTest: boolean,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const today = new Date().toISOString().slice(0, 10)
  const startOfMonth = `${today.slice(0, 7)}-01`

  if (name === 'list_expenses') {
    if (args.startDate !== undefined && !isDateString(args.startDate)) throw new Error('startDate must use YYYY-MM-DD format.')
    if (args.endDate !== undefined && !isDateString(args.endDate)) throw new Error('endDate must use YYYY-MM-DD format.')
    if (args.category !== undefined && !['Ăn uống', 'Di chuyển', 'Mua sắm', 'Nhà cửa', 'Giải trí', 'Sức khỏe', 'Khác'].includes(String(args.category))) {
      throw new Error('Unknown expense category.')
    }
    const limit = args.limit === undefined ? 100 : args.limit
    if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('limit must be an integer from 1 to 100.')
    const expenses = await readExpenses(env, uid)
    return expenses
      .filter((expense) => (!args.startDate || expense.date >= String(args.startDate))
        && (!args.endDate || expense.date <= String(args.endDate))
        && (!args.category || expense.category === args.category))
      .slice(0, limit)
  }

  if (name === 'get_spending_summary') {
    const startDate = args.startDate ?? startOfMonth
    const endDate = args.endDate ?? today
    if (!isDateString(startDate) || !isDateString(endDate) || startDate > endDate) {
      throw new Error('Provide a valid date range in YYYY-MM-DD format.')
    }
    const expenses = (await readExpenses(env, uid)).filter((expense) => expense.date >= startDate && expense.date <= endDate)
    const byCategory = Object.fromEntries([...new Set(expenses.map((expense) => expense.category))]
      .map((category) => [category, expenses.filter((expense) => expense.category === category).reduce((sum, expense) => sum + expense.amount, 0)]))
    return {
      startDate,
      endDate,
      transactionCount: expenses.length,
      total: expenses.reduce((sum, expense) => sum + expense.amount, 0),
      byCategory,
    }
  }

  if (name === 'get_budget') {
    const [profile, expenses] = await Promise.all([readProfile(env, uid), readExpenses(env, uid)])
    const spentThisMonth = expenses.filter((expense) => expense.date.startsWith(today.slice(0, 7))).reduce((sum, expense) => sum + expense.amount, 0)
    const spentToday = expenses.filter((expense) => expense.date === today).reduce((sum, expense) => sum + expense.amount, 0)
    const daysInMonth = new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0).getDate()
    const dailyBudget = Math.round(profile.monthlyBudget / daysInMonth)
    return {
      monthlyBudget: profile.monthlyBudget,
      spentThisMonth,
      remainingThisMonth: profile.monthlyBudget - spentThisMonth,
      dailyBudget,
      spentToday,
      remainingToday: dailyBudget - spentToday,
    }
  }

  if (name === 'create_expense') {
    if (!validExpense(args)) throw new Error('Expense fields are invalid. Provide title, positive integer amount, valid category, date, and optional note.')
    return await writeExpense(env, uid, args)
  }

  if (name === 'delete_expense') {
    if (typeof args.id !== 'string' || !/^[A-Za-z0-9_-]+$/.test(args.id)) throw new Error('A valid expense ID is required.')
    const result = await firestore(env, `${collectionPath(uid)}/expenses/${encodeURIComponent(args.id)}`, { method: 'DELETE' })
    if (!result.ok && result.status !== 404) throw new Error(await firestoreError(result, 'delete expense'))
    return { deleted: true, id: args.id }
  }

  if (name === 'set_monthly_budget') {
    const monthlyBudget = args.monthlyBudget
    if (typeof monthlyBudget !== 'number' || !Number.isSafeInteger(monthlyBudget) || monthlyBudget <= 0 || monthlyBudget > 1_000_000_000_000) {
      throw new Error('monthlyBudget must be a positive integer in VND.')
    }
    await writeBudget(env, uid, monthlyBudget)
    return { monthlyBudget }
  }

  if (name === 'reset_test_data' && isTest) {
    const root = collectionPath(uid)
    const existing = await firestore(env, `${root}/expenses?pageSize=1000`)
    if (!existing.ok) throw new Error(await firestoreError(existing, 'list sandbox expenses'))
    const data = await existing.json() as { documents?: Array<{ name: string }> }
    await Promise.all((data.documents ?? []).map(async (document) => {
      const documentPath = document.name.split('/documents/').at(-1)
      if (!documentPath) throw new Error('Firestore returned an invalid sandbox document path.')
      const response = await firestore(env, documentPath, { method: 'DELETE' })
      if (!response.ok && response.status !== 404) throw new Error(await firestoreError(response, 'reset sandbox expense'))
    }))
    const dates = [0, 1, 2].map((offset) => {
      const date = new Date()
      date.setDate(date.getDate() - offset)
      return date.toISOString().slice(0, 10)
    })
    const fixtures: Array<Omit<Expense, 'id'>> = [
      { title: 'Test · Cà phê', amount: 45000, category: 'Ăn uống', date: dates[0] },
      { title: 'Test · Di chuyển', amount: 32000, category: 'Di chuyển', date: dates[1] },
      { title: 'Test · Siêu thị', amount: 185000, category: 'Mua sắm', date: dates[2] },
    ]
    await Promise.all(fixtures.map((expense) => writeExpense(env, uid, expense)))
    await writeBudget(env, uid, 5_000_000)
    return { reset: true, sandbox: true, fixtureCount: fixtures.length, monthlyBudget: 5_000_000 }
  }

  throw new Error(`Unknown tool: ${name}`)
}

async function authenticateMcp(request: Request, env: Env): Promise<{ uid: string; isTest: boolean } | null> {
  const authorization = request.headers.get('Authorization')
  if (!authorization?.startsWith('Bearer ')) return null
  const token = authorization.slice(7)
  if (env.MCP_TEST_TOKEN && constantTimeEqual(token, env.MCP_TEST_TOKEN)) return { uid: 'mcp-sandbox', isTest: true }
  if (!token.startsWith('lmcp_')) return null
  const tokenHash = await hashToken(token)
  let result = await firestore(env, tokenIndexPath(tokenHash))
  if (result.status === 404) {
    const legacy = await firestore(env, `mcpTokens/${tokenHash}`)
    if (!legacy.ok) return null
    const legacyData = await legacy.json() as { fields?: Record<string, unknown> }
    const legacyFields = fieldsToObject(legacyData.fields ?? {})
    const legacyUid = legacyFields.uid
    if (typeof legacyUid !== 'string' || legacyUid.length > 128) return null
    await ensureLogmoneyNamespace(env, legacyUid)
    result = await firestore(env, tokenIndexPath(tokenHash))
  }
  if (!result.ok) return null
  const data = await result.json() as { fields?: Record<string, unknown> }
  const uid = fieldsToObject(data.fields ?? {}).uid
  if (typeof uid !== 'string' || uid.length > 128) return null
  await ensureLogmoneyNamespace(env, uid)
  return { uid, isTest: false }
}

async function handleMcp(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'POST') return new Response('MCP supports POST requests only.', { status: 405, headers: { Allow: 'POST' } })
  const identity = await authenticateMcp(request, env)
  if (!identity) return Response.json({ error: 'Invalid or missing MCP bearer token.' }, { status: 401, headers: { 'WWW-Authenticate': 'Bearer' } })
  const body: unknown = await request.json().catch(() => null)
  if (!body || typeof body !== 'object' || Array.isArray(body)) return mcpError(null, -32600, 'Invalid JSON-RPC request.')
  const rpc = body as McpRequest
  if (rpc.jsonrpc !== '2.0' || typeof rpc.method !== 'string') return mcpError(rpc.id ?? null, -32600, 'Invalid JSON-RPC request.')
  if (rpc.method === 'notifications/initialized' || rpc.method.startsWith('notifications/')) return new Response(null, { status: 202 })
  if (rpc.method === 'initialize') {
    return mcpResult(rpc.id ?? null, {
      protocolVersion: typeof rpc.params?.protocolVersion === 'string' ? rpc.params.protocolVersion : '2025-03-26',
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'logmoney', version: '1.0.0' },
      instructions: `Stateless Logmoney MCP. All data is scoped to the authenticated user. ${identity.isTest ? 'This token uses an isolated sandbox dataset; call reset_test_data to restore sample data.' : 'Ask for confirmation before deleting expenses or changing the budget.'}`,
    })
  }
  if (rpc.method === 'ping') return mcpResult(rpc.id ?? null, {})
  if (rpc.method === 'tools/list') {
    return mcpResult(rpc.id ?? null, {
      tools: identity.isTest
        ? [...mcpTools, {
            name: 'reset_test_data',
            description: 'Reset only the isolated MCP sandbox and restore sample expenses and a test budget.',
            inputSchema: { type: 'object', properties: {} },
          }]
        : mcpTools,
    })
  }
  if (rpc.method === 'tools/call') {
    const name = rpc.params?.name
    const args = rpc.params?.arguments ?? {}
    if (typeof name !== 'string' || !args || typeof args !== 'object' || Array.isArray(args)) {
      return mcpError(rpc.id ?? null, -32602, 'Invalid tools/call parameters.')
    }
    try {
      const result = await runMcpTool(env, identity.uid, identity.isTest, name, args as Record<string, unknown>)
      return mcpResult(rpc.id ?? null, toolResult(result))
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Tool execution failed.'
      console.error(`MCP tool ${name} failed: ${message}`)
      return mcpResult(rpc.id ?? null, toolResult({ error: message }, true))
    }
  }
  return mcpError(rpc.id ?? null, -32601, `Method not found: ${rpc.method}`)
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const origin = request.headers.get('Origin')
    const allowedOrigins = env.ALLOWED_ORIGIN.split(',').map((value) => value.trim())
    if (origin && !allowedOrigins.includes(origin)) return Response.json({ error: 'Origin không được phép.' }, { status: 403 })
    const requestEnv = origin ? { ...env, ALLOWED_ORIGIN: origin } : env
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: {
      'Access-Control-Allow-Origin': requestEnv.ALLOWED_ORIGIN,
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type',
      'Vary': 'Origin',
    } })
    try {
      if (new URL(request.url).pathname === '/mcp') return await handleMcp(request, requestEnv)
      const authorization = request.headers.get('Authorization')
      if (!authorization?.startsWith('Bearer ')) return respond({ error: 'Cần đăng nhập để tiếp tục.' }, 401, requestEnv.ALLOWED_ORIGIN)
      const { payload } = await jwtVerify(authorization.slice(7), firebaseKeys, {
        audience: env.FIREBASE_PROJECT_ID,
        issuer: `https://securetoken.google.com/${env.FIREBASE_PROJECT_ID}`,
      })
      if (!payload.sub || payload.sub.length > 128) return respond({ error: 'Phiên đăng nhập không hợp lệ.' }, 401, requestEnv.ALLOWED_ORIGIN)
      await ensureLogmoneyNamespace(requestEnv, payload.sub)
      return await route(request, requestEnv, payload.sub)
    } catch (error) {
      console.error('Worker request failed:', error)
      return respond({ error: 'Không thể hoàn tất yêu cầu.' }, 500, requestEnv.ALLOWED_ORIGIN)
    }
  },
}
