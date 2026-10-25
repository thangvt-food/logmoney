export type Category =
  | 'Ăn uống'
  | 'Di chuyển'
  | 'Mua sắm'
  | 'Nhà cửa'
  | 'Giải trí'
  | 'Sức khỏe'
  | 'Khác'

export type Expense = {
  id: string
  title: string
  amount: number
  category: Category
  date: string
  note?: string
}

export type Profile = { monthlyBudget: number }

export const CATEGORIES: Category[] = [
  'Ăn uống',
  'Di chuyển',
  'Mua sắm',
  'Nhà cửa',
  'Giải trí',
  'Sức khỏe',
  'Khác',
]
