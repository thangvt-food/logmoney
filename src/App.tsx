import { useEffect, useMemo, useState } from 'react'
import {
  ArrowDownLeft, ArrowRight, ArrowUpRight, Bell, BrainCircuit, CalendarDays, Check, ChevronDown,
  CircleHelp, Coffee, Copy, CreditCard, Film, Home as HomeIcon, LogOut, Menu, MoreHorizontal,
  Plus, Settings2, ShoppingBag, Sparkles, Stethoscope, TrainFront, TrendingUp, Wallet, X,
} from 'lucide-react'
import { addExpense, createMcpToken, getExpenses, getMcpTokens, getProfile, removeExpense, revokeMcpToken, type McpTokenInfo, updateBudget } from './api'
import { auth, firebaseConfigured, signInGoogle, signOutGoogle } from './firebase'
import { CATEGORIES, type Category, type Expense, type Profile } from './types'
import type { User } from 'firebase/auth'

type Tab = 'Tổng quan' | 'Giao dịch' | 'Ngân sách' | 'Cá nhân'
type CategoryFilter = 'Tất cả' | Category
type ExpenseDraft = { title: string; amount: string; category: Category; date: string; note: string }

const icons = {
  'Ăn uống': Coffee, 'Di chuyển': TrainFront, 'Mua sắm': ShoppingBag,
  'Nhà cửa': HomeIcon, 'Giải trí': Film, 'Sức khỏe': Stethoscope, 'Khác': MoreHorizontal,
}

const formatMoney = (amount: number) => `${new Intl.NumberFormat('vi-VN').format(Math.round(amount))} ₫`
const localDate = (date = new Date()) => {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}
const monthLabel = new Intl.DateTimeFormat('vi-VN', { month: 'long', year: 'numeric' }).format(new Date())
const shortDate = (date: string) => {
  const value = new Date(`${date}T12:00:00`)
  if (date === localDate()) return 'Hôm nay'
  if (date === localDate(new Date(Date.now() - 86400000))) return 'Hôm qua'
  return new Intl.DateTimeFormat('vi-VN', { day: 'numeric', month: 'short' }).format(value)
}

function App() {
  const [user, setUser] = useState<User | null>(null)
  const [authReady, setAuthReady] = useState(!firebaseConfigured)
  const [expenses, setExpenses] = useState<Expense[]>([])
  const [profile, setProfile] = useState<Profile>({ monthlyBudget: 12000000 })
  const [activeTab, setActiveTab] = useState<Tab>('Tổng quan')
  const [filter, setFilter] = useState<CategoryFilter>('Tất cả')
  const [modal, setModal] = useState<'expense' | 'budget' | null>(null)
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [mcpTokens, setMcpTokens] = useState<McpTokenInfo[]>([])
  const [mcpLabel, setMcpLabel] = useState('AI assistant')
  const [newMcpToken, setNewMcpToken] = useState('')
  const [mcpBusy, setMcpBusy] = useState(false)
  const [installPrompt, setInstallPrompt] = useState<BeforeInstallPromptEvent | null>(null)
  const [draft, setDraft] = useState<ExpenseDraft>({
    title: '', amount: '', category: 'Ăn uống', date: localDate(), note: '',
  })

  useEffect(() => {
    if (!auth) return
    return auth.onAuthStateChanged((nextUser) => {
      setUser(nextUser)
      setAuthReady(true)
    })
  }, [])

  const token = user
  const loadData = async () => {
    setLoading(true)
    setError('')
    try {
      const idToken = token ? await token.getIdToken() : undefined
      const [nextExpenses, nextProfile] = await Promise.all([getExpenses(idToken), getProfile(idToken)])
      setExpenses(nextExpenses.sort((a, b) => b.date.localeCompare(a.date)))
      setProfile(nextProfile)
      if (idToken) setMcpTokens(await getMcpTokens(idToken))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Không thể tải dữ liệu.')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { void loadData() }, [user])

  useEffect(() => {
    const handler = (event: Event) => {
      event.preventDefault()
      setInstallPrompt(event as BeforeInstallPromptEvent)
    }
    window.addEventListener('beforeinstallprompt', handler)
    return () => window.removeEventListener('beforeinstallprompt', handler)
  }, [])

  const currentMonth = localDate().slice(0, 7)
  const monthExpenses = useMemo(() => expenses.filter((expense) => expense.date.startsWith(currentMonth)), [expenses, currentMonth])
  const todayExpenses = useMemo(() => expenses.filter((expense) => expense.date === localDate()), [expenses])
  const spentThisMonth = monthExpenses.reduce((sum, expense) => sum + expense.amount, 0)
  const spentToday = todayExpenses.reduce((sum, expense) => sum + expense.amount, 0)
  const daysInCurrentMonth = new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0).getDate()
  const dailyBudget = Math.round(profile.monthlyBudget / daysInCurrentMonth)
  const dailyBudgetRemaining = dailyBudget - spentToday
  const dailyBudgetProgress = dailyBudget > 0 ? Math.min(spentToday / dailyBudget * 100, 100) : 0
  const budgetRemaining = profile.monthlyBudget - spentThisMonth
  const budgetProgress = profile.monthlyBudget > 0 ? Math.min(spentThisMonth / profile.monthlyBudget * 100, 100) : 0
  const filteredExpenses = useMemo(
    () => (filter === 'Tất cả' ? expenses : expenses.filter((expense) => expense.category === filter)),
    [expenses, filter],
  )
  const dailyBars = useMemo(() => {
    const today = new Date()
    return Array.from({ length: 7 }, (_, index) => {
      const date = new Date(today)
      date.setDate(today.getDate() - 6 + index)
      const key = localDate(date)
      return {
        key,
        label: index === 6 ? 'Nay' : new Intl.DateTimeFormat('vi-VN', { weekday: 'short' }).format(date).replace('.', ''),
        amount: expenses.filter((expense) => expense.date === key).reduce((sum, expense) => sum + expense.amount, 0),
      }
    })
  }, [expenses])
  const maxBar = Math.max(...dailyBars.map((bar) => bar.amount), 1)

  const saveExpense = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const amount = Number(draft.amount.replace(/\D/g, ''))
    if (!draft.title.trim() || amount <= 0) {
      setError('Hãy nhập tên khoản chi và số tiền lớn hơn 0.')
      return
    }
    setSaving(true)
    setError('')
    try {
      const idToken = user ? await user.getIdToken() : undefined
      const created = await addExpense({
        title: draft.title.trim(), amount, category: draft.category, date: draft.date, note: draft.note.trim() || undefined,
      }, idToken)
      setExpenses((current) => [created, ...current].sort((a, b) => b.date.localeCompare(a.date)))
      setDraft({ title: '', amount: '', category: 'Ăn uống', date: localDate(), note: '' })
      setModal(null)
      setNotice('Đã lưu khoản chi')
      window.setTimeout(() => setNotice(''), 2400)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Không thể lưu khoản chi.')
    } finally {
      setSaving(false)
    }
  }

  const saveBudget = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const amount = Number(String(form.get('budget')).replace(/\D/g, ''))
    if (amount <= 0) {
      setError('Ngân sách cần lớn hơn 0.')
      return
    }
    setSaving(true)
    setError('')
    try {
      const idToken = user ? await user.getIdToken() : undefined
      setProfile(await updateBudget(amount, idToken))
      setModal(null)
      setNotice('Đã cập nhật ngân sách')
      window.setTimeout(() => setNotice(''), 2400)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Không thể cập nhật ngân sách.')
    } finally {
      setSaving(false)
    }
  }

  const issueMcpToken = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!user || !mcpLabel.trim()) return
    setMcpBusy(true)
    setError('')
    setNewMcpToken('')
    try {
      const idToken = await user.getIdToken()
      const created = await createMcpToken(mcpLabel.trim(), idToken)
      setMcpTokens((current) => [created.tokenInfo, ...current])
      setNewMcpToken(created.token)
      setMcpLabel('')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Không thể tạo MCP token.')
    } finally {
      setMcpBusy(false)
    }
  }

  const revokeOneMcpToken = async (tokenInfo: McpTokenInfo) => {
    if (!user || !window.confirm(`Thu hồi token "${tokenInfo.label}"? Assistant đang dùng token này sẽ mất quyền truy cập.`)) return
    setMcpBusy(true)
    setError('')
    try {
      await revokeMcpToken(tokenInfo.id, await user.getIdToken())
      setMcpTokens((current) => current.filter((item) => item.id !== tokenInfo.id))
      setNotice('Đã thu hồi MCP token')
      window.setTimeout(() => setNotice(''), 2400)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Không thể thu hồi MCP token.')
    } finally {
      setMcpBusy(false)
    }
  }

  const copyText = async (text: string, message: string) => {
    try {
      await navigator.clipboard.writeText(text)
      setNotice(message)
      window.setTimeout(() => setNotice(''), 2400)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Không thể sao chép.')
    }
  }

  const deleteOne = async (expense: Expense) => {
    if (!window.confirm(`Xóa khoản chi "${expense.title}"?`)) return
    try {
      const idToken = user ? await user.getIdToken() : undefined
      await removeExpense(expense.id, idToken)
      setExpenses((current) => current.filter((item) => item.id !== expense.id))
      setNotice('Đã xóa khoản chi')
      window.setTimeout(() => setNotice(''), 2400)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Không thể xóa khoản chi.')
    }
  }

  if (!authReady) return <div className="screen-center"><div className="loading-dot" /><span>Đang mở sổ chi tiêu...</span></div>
  if (firebaseConfigured && !user) {
    return (
      <main className="login-page">
        <div className="login-card">
          <Brand />
          <div className="login-art"><Wallet size={76} strokeWidth={1.2} /><Sparkles className="login-sparkle" size={25} /></div>
          <p className="eyebrow">SỔ CHI TIÊU CỦA RIÊNG BẠN</p>
          <h1>Nhẹ đầu hơn,<br />với chuyện tiền nong.</h1>
          <p className="login-copy">Ghi lại từng khoản nhỏ. Cuối tháng, bạn sẽ biết tiền của mình đã đi đâu.</p>
          <button className="google-button" onClick={() => void signInGoogle().catch((cause: Error) => setError(cause.message))}>
            <GoogleMark /> Tiếp tục với Google
          </button>
          {error && <p className="inline-error">{error}</p>}
          <p className="login-privacy">Riêng tư theo tài khoản. Dữ liệu chỉ mình bạn nhìn thấy.</p>
        </div>
      </main>
    )
  }

  const showList = activeTab === 'Giao dịch'
  const visibleList = showList ? filteredExpenses : expenses.slice(0, 5)
  const grouped = visibleList.reduce<Record<string, Expense[]>>((groups, expense) => {
    ;(groups[expense.date] ??= []).push(expense)
    return groups
  }, {})

  return (
    <div className="app-shell">
      <header className="topbar">
        <Brand />
        <div className="topbar-actions">
          <button className="icon-button notification-button" aria-label="Thông báo"><Bell size={19} /><i /></button>
          <button className="avatar-button" aria-label="Tài khoản" onClick={() => setActiveTab('Cá nhân')}>
            {user?.photoURL ? <img src={user.photoURL} alt="" /> : <span>{user?.displayName?.slice(0, 1) || 'M'}</span>}
          </button>
        </div>
      </header>

      <main className="main-content">
        {!firebaseConfigured && <div className="demo-banner"><span className="demo-dot" /> Bản dùng thử · Dữ liệu lưu trên thiết bị này</div>}
        {error && <div className="error-banner" role="alert">{error}<button aria-label="Đóng" onClick={() => setError('')}><X size={16} /></button></div>}

        {activeTab === 'Cá nhân' ? (
          <section className="page-section profile-page">
            <SectionHeading eyebrow="TÀI KHOẢN" title="Cá nhân" />
            <div className="profile-card">
              <div className="profile-avatar">{user?.photoURL ? <img src={user.photoURL} alt="" /> : <span>{user?.displayName?.slice(0, 1) || 'M'}</span>}</div>
              <div><strong>{user?.displayName || 'Bạn của Logmoney'}</strong><p>{user?.email || 'Đang dùng chế độ trên thiết bị'}</p></div>
            </div>
            <button className="settings-row" onClick={() => setModal('budget')}><span className="settings-icon"><Settings2 size={19} /></span><span><strong>Ngân sách tháng</strong><small>{formatMoney(profile.monthlyBudget)}</small></span><ArrowRight size={17} /></button>
            {user && <section className="mcp-card">
              <div className="mcp-heading"><span className="mcp-icon"><BrainCircuit size={19} /></span><div><strong>Kết nối AI assistant</strong><small>MCP stateless · quyền theo token</small></div></div>
              <p className="mcp-description">Cho phép assistant đọc và ghi sổ chi tiêu của bạn. Mỗi request được xác thực độc lập; không tạo session MCP.</p>
              <div className="mcp-endpoint"><span>Endpoint</span><code>{window.location.origin}/mcp</code><button aria-label="Sao chép MCP endpoint" onClick={() => void copyText(`${window.location.origin}/mcp`, 'Đã sao chép MCP endpoint')}><Copy size={15} /></button></div>
              {newMcpToken && <div className="mcp-token-reveal"><strong>Token chỉ hiển thị lần này</strong><p>Hãy sao chép và lưu vào secret của assistant. Rời trang sẽ không xem lại được.</p><div><code>{newMcpToken}</code><button aria-label="Sao chép MCP token" onClick={() => void copyText(newMcpToken, 'Đã sao chép token')}><Copy size={15} /></button></div><button className="dismiss-token" onClick={() => setNewMcpToken('')}>Đã lưu token</button></div>}
              <form className="mcp-create-form" onSubmit={(event) => void issueMcpToken(event)}><input aria-label="Tên MCP token" placeholder="Tên assistant, ví dụ: Copilot" value={mcpLabel} onChange={(event) => setMcpLabel(event.target.value)} maxLength={60} required /><button type="submit" disabled={mcpBusy || !mcpLabel.trim()}><Plus size={15} /> Tạo token</button></form>
              {mcpTokens.length > 0 && <div className="mcp-token-list">{mcpTokens.map((item) => <div className="mcp-token-item" key={item.id}><span><strong>{item.label}</strong><small>Tạo ngày {new Intl.DateTimeFormat('vi-VN', { day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(item.createdAt))}</small></span><button disabled={mcpBusy} aria-label={`Thu hồi token ${item.label}`} onClick={() => void revokeOneMcpToken(item)}><X size={16} /></button></div>)}</div>}
              <div className="mcp-abilities"><span>Đọc chi tiêu</span><span>Thêm / xóa giao dịch</span><span>Quản lý ngân sách</span></div>
            </section>}
            {installPrompt && <button className="settings-row" onClick={() => void installPrompt.prompt()}><span className="settings-icon"><Plus size={19} /></span><span><strong>Cài ứng dụng</strong><small>Thêm Logmoney vào màn hình chính</small></span><ArrowRight size={17} /></button>}
            {user && <button className="settings-row signout-row" onClick={() => void signOutGoogle()}><span className="settings-icon"><LogOut size={19} /></span><span><strong>Đăng xuất</strong><small>Đăng xuất khỏi tài khoản Google</small></span><ArrowRight size={17} /></button>}
            <div className="help-card"><CircleHelp size={20} /><div><strong>Chi tiêu rõ ràng, sống thảnh thơi.</strong><p>Mỗi ngày một chút, cuối tháng nhẹ nhàng hơn.</p></div></div>
          </section>
        ) : activeTab === 'Ngân sách' ? (
          <section className="page-section">
            <SectionHeading eyebrow="KẾ HOẠCH THÁNG" title="Ngân sách" />
            <BudgetCard spent={spentThisMonth} budget={profile.monthlyBudget} progress={budgetProgress} remaining={budgetRemaining} onEdit={() => setModal('budget')} expanded />
            <div className="section-title-row budget-spend-title"><div><p className="eyebrow">PHÂN BỔ CHI TIÊU</p><h2>Tháng này</h2></div><span>{monthExpenses.length} khoản</span></div>
            <CategoryBreakdown expenses={monthExpenses} total={spentThisMonth} />
            <div className="tip-card"><Sparkles size={18} /><p>{budgetRemaining >= 0 ? `Bạn còn ${formatMoney(budgetRemaining)} cho đến hết tháng. Cứ giữ nhịp này nhé!` : `Bạn đã chi vượt ngân sách ${formatMoney(Math.abs(budgetRemaining))}. Thử xem lại vài khoản gần đây nhé.`}</p></div>
          </section>
        ) : (
          <section className="page-section">
            <div className="greeting-row">
              <div><p className="eyebrow">{monthLabel.toLocaleUpperCase('vi-VN')}</p><h1>{showList ? 'Sổ chi tiêu' : <>Chào {user?.displayName?.split(' ')[0] || 'bạn'} <span className="wave">✳</span></>}</h1></div>
              {showList && <button className="filter-date"><CalendarDays size={16} /> Tháng này <ChevronDown size={14} /></button>}
            </div>
            {activeTab === 'Tổng quan' && (
              <>
                <BudgetCard spent={spentThisMonth} budget={profile.monthlyBudget} progress={budgetProgress} remaining={budgetRemaining} onEdit={() => setModal('budget')} />
                <div className="today-card">
                  <div className="today-card-top"><div className="today-icon"><Wallet size={19} /></div><span>CHI TIÊU HÔM NAY</span><span className="today-date">{new Intl.DateTimeFormat('vi-VN', { day: 'numeric', month: 'short' }).format(new Date())}</span></div>
                  <div className="today-amount">{formatMoney(spentToday)}</div>
                  <div className="today-foot"><span>{todayExpenses.length ? `${todayExpenses.length} khoản chi` : 'Chưa có khoản chi nào'}</span><span>Hạn mức ngày {formatMoney(dailyBudget)}</span></div>
                  <div className="daily-budget-meter" role="progressbar" aria-label="Ngân sách đã sử dụng hôm nay" aria-valuenow={Math.round(dailyBudgetProgress)} aria-valuemin={0} aria-valuemax={100}><span className={dailyBudgetRemaining < 0 ? 'over-budget' : ''} style={{ width: `${dailyBudgetProgress}%` }} /></div>
                  <div className="daily-budget-caption"><span>{Math.round(spentToday / Math.max(dailyBudget, 1) * 100)}% hạn mức ngày</span><span className={dailyBudgetRemaining < 0 ? 'daily-over-text' : ''}>{dailyBudgetRemaining >= 0 ? `Còn ${formatMoney(dailyBudgetRemaining)}` : `Vượt ${formatMoney(Math.abs(dailyBudgetRemaining))}`}</span></div>
                </div>
                <div className="chart-card">
                  <div className="section-title-row"><div><p className="eyebrow">NHỊP CHI TIÊU</p><h2>7 ngày gần đây</h2></div><div className="chart-legend"><span /> Chi tiêu</div></div>
                  <div className="bar-chart" aria-label="Biểu đồ chi tiêu 7 ngày gần đây">
                    {dailyBars.map((bar) => <div className="bar-column" key={bar.key}><div className="bar-track"><div className={`bar-fill ${bar.key === localDate() ? 'bar-today' : ''}`} style={{ height: `${Math.max(bar.amount / maxBar * 100, bar.amount ? 9 : 3)}%` }} /></div><span className={bar.key === localDate() ? 'bar-label active' : 'bar-label'}>{bar.label}</span></div>)}
                  </div>
                </div>
              </>
            )}
            {showList && (
              <div className="filter-chips" role="tablist" aria-label="Lọc theo danh mục">
                {(['Tất cả', ...CATEGORIES] as CategoryFilter[]).map((category) => <button key={category} role="tab" aria-selected={filter === category} className={filter === category ? 'filter-chip selected' : 'filter-chip'} onClick={() => setFilter(category)}>{category}</button>)}
              </div>
            )}
            <div className="transactions-section">
              <div className="section-title-row"><div><p className="eyebrow">{showList ? 'TẤT CẢ KHOẢN CHI' : 'MỚI CẬP NHẬT'}</p><h2>{showList ? 'Giao dịch' : 'Gần đây'}</h2></div>{!showList && <button className="text-button" onClick={() => setActiveTab('Giao dịch')}>Xem tất cả <ArrowRight size={15} /></button>}</div>
              {loading ? <div className="empty-state">Đang tải sổ chi tiêu...</div> : Object.keys(grouped).length === 0 ? <div className="empty-state"><span className="empty-icon"><Wallet size={22} /></span><strong>Chưa có khoản chi nào</strong><span>Ghi lại khoản đầu tiên để bắt đầu nhé.</span></div> : Object.entries(grouped).map(([date, items]) => <div className="day-group" key={date}><div className="day-heading"><span>{shortDate(date)}</span><span>{formatMoney(items.reduce((sum, item) => sum + item.amount, 0))}</span></div>{items.map((expense) => <ExpenseRow key={expense.id} expense={expense} onDelete={() => void deleteOne(expense)} />)}</div>)}
            </div>
          </section>
        )}
      </main>

      <button className="fab" aria-label="Thêm khoản chi" onClick={() => { setError(''); setModal('expense') }}><Plus size={25} strokeWidth={2.4} /><span>Thêm khoản chi</span></button>
      <nav className="bottom-nav" aria-label="Điều hướng chính">
        {([
          ['Tổng quan', Wallet], ['Giao dịch', CreditCard], ['Ngân sách', TrendingUp], ['Cá nhân', Menu],
        ] as const).map(([tab, Icon]) => <button key={tab} className={`nav-item ${activeTab === tab ? 'active' : ''}`} aria-current={activeTab === tab ? 'page' : undefined} onClick={() => setActiveTab(tab)}><Icon size={20} strokeWidth={activeTab === tab ? 2.2 : 1.8} /><span>{tab}</span></button>)}
      </nav>

      {modal && <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setModal(null) }}><section className="bottom-sheet" role="dialog" aria-modal="true" aria-labelledby="sheet-title">
        <div className="sheet-handle" />
        <div className="sheet-heading"><div><p className="eyebrow">{modal === 'expense' ? 'GHI LẠI MỘT CHÚT' : 'ĐẶT MỤC TIÊU THÁNG'}</p><h2 id="sheet-title">{modal === 'expense' ? 'Thêm khoản chi' : 'Ngân sách tháng'}</h2></div><button className="icon-button close-button" aria-label="Đóng" onClick={() => setModal(null)}><X size={20} /></button></div>
        {modal === 'expense' ? <form className="expense-form" onSubmit={(event) => void saveExpense(event)}>
          <label className="field-label">Tên khoản chi<input autoFocus placeholder="Ví dụ: Cà phê sáng" value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} maxLength={80} required /></label>
          <label className="field-label">Số tiền<div className="money-input"><input placeholder="0" inputMode="numeric" value={draft.amount ? new Intl.NumberFormat('vi-VN').format(Number(draft.amount.replace(/\D/g, ''))) : ''} onChange={(event) => setDraft({ ...draft, amount: event.target.value.replace(/\D/g, '') })} required /><span>₫</span></div></label>
          <div className="field-label">Danh mục<div className="category-picker">{CATEGORIES.map((category) => { const Icon = icons[category]; return <button type="button" key={category} className={`category-option ${draft.category === category ? 'picked' : ''}`} onClick={() => setDraft({ ...draft, category })}><Icon size={17} /><span>{category}</span></button> })}</div></div>
          <label className="field-label">Ngày<input type="date" value={draft.date} max={localDate()} onChange={(event) => setDraft({ ...draft, date: event.target.value })} required /></label>
          <label className="field-label">Ghi chú <span className="optional">(không bắt buộc)</span><input placeholder="Thêm một chút ngữ cảnh..." value={draft.note} onChange={(event) => setDraft({ ...draft, note: event.target.value })} maxLength={160} /></label>
          <button className="primary-button" type="submit" disabled={saving}>{saving ? 'Đang lưu...' : <><Check size={18} /> Lưu khoản chi</>}</button>
        </form> : <form className="expense-form" onSubmit={(event) => void saveBudget(event)}>
          <p className="budget-explainer">Đặt giới hạn chi tiêu cho tháng này. Logmoney sẽ giúp bạn theo dõi số tiền còn lại.</p>
          <label className="field-label">Ngân sách tháng<div className="money-input"><input name="budget" defaultValue={new Intl.NumberFormat('vi-VN').format(profile.monthlyBudget)} inputMode="numeric" onChange={(event) => { const digits = event.target.value.replace(/\D/g, ''); event.target.value = digits ? new Intl.NumberFormat('vi-VN').format(Number(digits)) : '' }} required /><span>₫</span></div></label>
          <button className="primary-button" type="submit" disabled={saving}>{saving ? 'Đang lưu...' : <><Check size={18} /> Lưu ngân sách</>}</button>
        </form>}
      </section></div>}
      {notice && <div className="toast"><span><Check size={15} /></span>{notice}</div>}
    </div>
  )
}

type BeforeInstallPromptEvent = Event & { prompt: () => Promise<void> }

function Brand() {
  return <a href="#" className="brand" aria-label="Logmoney trang chủ" onClick={(event) => event.preventDefault()}><span className="brand-mark">l<span>.</span></span><span>logmoney</span></a>
}

function GoogleMark() {
  return <svg aria-hidden="true" width="18" height="18" viewBox="0 0 48 48"><path fill="#FFC107" d="M43.6 24.5c0-1.4-.1-2.8-.4-4.1H24v7.8h11c-.5 2.5-1.9 4.6-4.1 6v5h6.6c3.9-3.6 6.1-8.8 6.1-14.7z" /><path fill="#34A853" d="M24 44c5.5 0 10.1-1.8 13.5-4.8l-6.6-5c-1.8 1.2-4.1 2-6.9 2-5.3 0-9.8-3.6-11.4-8.4h-6.8v5.2C9.2 39.6 16 44 24 44z" /><path fill="#4A90E2" d="M12.6 27.8c-.4-1.2-.7-2.5-.7-3.8s.2-2.6.7-3.8V15H5.8C4.4 17.7 3.5 20.8 3.5 24s.9 6.3 2.3 9l6.8-5.2z" /><path fill="#EA4335" d="M24 11.6c3 0 5.7 1 7.8 3.1l5.9-5.9C34.1 5.5 29.5 3.5 24 3.5c-8 0-14.8 4.4-18.2 11l6.8 5.2c1.6-4.8 6.1-8.1 11.4-8.1z" /></svg>
}

function SectionHeading({ eyebrow, title }: { eyebrow: string; title: string }) {
  return <div className="page-heading"><p className="eyebrow">{eyebrow}</p><h1>{title}</h1></div>
}

function BudgetCard({ spent, budget, progress, remaining, onEdit, expanded = false }: { spent: number; budget: number; progress: number; remaining: number; onEdit: () => void; expanded?: boolean }) {
  return <article className={`budget-card ${expanded ? 'budget-card-expanded' : ''}`}>
    <div className="budget-card-head"><div className="budget-title"><span className="budget-icon"><Wallet size={19} /></span><div><p className="eyebrow">NGÂN SÁCH THÁNG</p><span className="budget-period">{monthLabel}</span></div></div><button className="budget-edit" onClick={onEdit} aria-label="Chỉnh sửa ngân sách"><MoreHorizontal size={20} /></button></div>
    <div className="budget-total">{formatMoney(spent)}<span> / {formatMoney(budget)}</span></div>
    <div className="budget-meter" role="progressbar" aria-label="Ngân sách đã sử dụng" aria-valuenow={Math.round(progress)} aria-valuemin={0} aria-valuemax={100}><span className={remaining < 0 ? 'over-budget' : ''} style={{ width: `${progress}%` }} /></div>
    <div className="budget-foot"><span>{Math.round(progress)}% đã sử dụng</span><span className={remaining < 0 ? 'over-text' : ''}>{remaining >= 0 ? `Còn ${formatMoney(remaining)}` : `Vượt ${formatMoney(Math.abs(remaining))}`}</span></div>
    {expanded && <div className="budget-status"><span className={remaining < 0 ? 'status-icon status-warn' : 'status-icon'}>{remaining < 0 ? <ArrowUpRight size={18} /> : <ArrowDownLeft size={18} />}</span><div><strong>{remaining >= 0 ? 'Bạn đang trong kế hoạch' : 'Đã vượt ngân sách'}</strong><p>{remaining >= 0 ? `Còn ${formatMoney(remaining)} cho đến hết tháng.` : `Bạn đã chi hơn kế hoạch ${formatMoney(Math.abs(remaining))}.`}</p></div></div>}
  </article>
}

function ExpenseRow({ expense, onDelete }: { expense: Expense; onDelete: () => void }) {
  const Icon = icons[expense.category]
  return <article className="expense-row"><div className={`expense-icon cat-${CATEGORIES.indexOf(expense.category)}`}><Icon size={19} strokeWidth={1.8} /></div><div className="expense-info"><strong>{expense.title}</strong><span>{expense.category}{expense.note ? ` · ${expense.note}` : ''}</span></div><div className="expense-amount">{formatMoney(expense.amount)}<button className="delete-expense" onClick={onDelete} aria-label={`Xóa ${expense.title}`}><X size={14} /></button></div></article>
}

function CategoryBreakdown({ expenses, total }: { expenses: Expense[]; total: number }) {
  const groups = CATEGORIES.map((category) => ({ category, amount: expenses.filter((expense) => expense.category === category).reduce((sum, expense) => sum + expense.amount, 0) })).filter((group) => group.amount > 0).sort((a, b) => b.amount - a.amount)
  if (!groups.length) return <div className="empty-state compact-empty">Chưa có dữ liệu để phân tích.</div>
  return <div className="breakdown-list">{groups.map(({ category, amount }) => { const Icon = icons[category]; return <div className="breakdown-item" key={category}><div className={`expense-icon cat-${CATEGORIES.indexOf(category)}`}><Icon size={17} /></div><div className="breakdown-main"><div className="breakdown-label"><strong>{category}</strong><span>{formatMoney(amount)}</span></div><div className="breakdown-meter"><span style={{ width: `${amount / total * 100}%` }} /></div></div><span className="breakdown-percent">{Math.round(amount / total * 100)}%</span></div> })}</div>
}

export default App
