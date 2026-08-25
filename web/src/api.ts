/**
 * Thin typed fetch client, one function per `/api/**` route exposed by
 * `src/server/app.ts`. All authed routes rely on the `session` cookie set by
 * `login()` -- every call passes `credentials: 'include'` so the cookie
 * rides along; no auth header is ever sent.
 *
 * Types here mirror the server's response shapes (see
 * `src/storage/schema.ts`, `src/domain/budget.ts`, `src/domain/summary.ts`,
 * `src/domain/transaction.ts`) but are declared locally rather than
 * imported -- `web/` is an independently built, independently deployed
 * package with no compile-time dependency on the server's source tree.
 */

export type TransactionKind = 'income' | 'expense';

export interface Transaction {
  readonly date: string;
  readonly category: string;
  readonly kind: TransactionKind;
  readonly amountMinor: number;
  readonly note?: string;
}

export interface StoredTransaction {
  readonly id: string;
  readonly transaction: Transaction;
}

export interface CategoryLimit {
  readonly effectiveFrom: string;
  readonly amountMinor: number;
}

export interface CategoryBudget {
  readonly category: string;
  readonly rollover: boolean;
  readonly limits: readonly CategoryLimit[];
}

export type BudgetState = 'over' | 'at' | 'under';

export interface PeriodBudgetStatus {
  readonly period: string;
  readonly category: string;
  readonly limitMinor: number;
  readonly carryInMinor: number;
  readonly availableMinor: number;
  readonly spentMinor: number;
  readonly state: BudgetState;
  readonly pctUsed: number | null;
}

export interface PeriodSummary {
  readonly period: string;
  readonly incomeMinor: number;
  readonly expenseMinor: number;
  readonly netMinor: number;
}

export interface CategorySpend {
  readonly category: string;
  readonly spentMinor: number;
}

export interface SummaryResult {
  readonly period: PeriodSummary;
  readonly byCategory: readonly CategorySpend[];
}

export interface ListTransactionsFilter {
  readonly from?: string;
  readonly to?: string;
  readonly category?: string;
  readonly kind?: string;
  readonly note?: string;
}

export interface AddTransactionInput {
  readonly amount: string;
  readonly category: string;
  readonly kind: string;
  readonly date?: string;
  readonly note?: string;
}

export interface SetLimitInput {
  readonly category: string;
  readonly amount: string;
  readonly effectiveFrom: string;
  readonly rollover?: boolean;
}

export class ApiError extends Error {
  /**
   * The response's HTTP status code, when a response was actually received
   * (e.g. `429` for a rate-limited login). Undefined for failures that never
   * produced a `Response` at all (network error) or for a `Response`-shaped
   * test double that omits `status`.
   */
  readonly status: number | undefined;

  constructor(message: string, status: number | undefined) {
    super(message);
    this.status = status;
  }
}

async function parseErrorMessage(res: Response): Promise<string> {
  try {
    const body: unknown = await res.json();
    if (
      typeof body === 'object' &&
      body !== null &&
      'error' in body &&
      typeof (body as { error: unknown }).error === 'string'
    ) {
      return (body as { error: string }).error;
    }
  } catch {
    // response body wasn't JSON -- fall through to the generic message below
  }
  return `request failed with status ${res.status}`;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    credentials: 'include',
    ...init,
    headers: {
      ...(init?.body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...init?.headers,
    },
  });

  if (!res.ok) {
    throw new ApiError(await parseErrorMessage(res), res.status);
  }

  if (res.status === 204) {
    return undefined as T;
  }

  return (await res.json()) as T;
}

export function login(username: string, password: string): Promise<{ username: string }> {
  return request('/api/login', { method: 'POST', body: JSON.stringify({ username, password }) });
}

export function logout(): Promise<{ ok: boolean }> {
  return request('/api/logout', { method: 'POST' });
}

export function startDemo(): Promise<{ username: string }> {
  return request('/api/demo', { method: 'POST' });
}

export function me(): Promise<{ username: string }> {
  return request('/api/me');
}

export function listTransactions(filter: ListTransactionsFilter = {}): Promise<StoredTransaction[]> {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filter)) {
    if (value !== undefined && value !== '') {
      params.set(key, value);
    }
  }
  const query = params.toString();
  return request(`/api/transactions${query !== '' ? `?${query}` : ''}`);
}

export function addTransaction(input: AddTransactionInput): Promise<StoredTransaction> {
  return request('/api/transactions', { method: 'POST', body: JSON.stringify(input) });
}

export function removeTransaction(id: string): Promise<StoredTransaction> {
  return request(`/api/transactions/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export function setLimit(input: SetLimitInput): Promise<CategoryBudget> {
  return request('/api/limits', { method: 'PUT', body: JSON.stringify(input) });
}

export function removeLimit(category: string): Promise<CategoryBudget> {
  return request(`/api/limits/${encodeURIComponent(category)}`, { method: 'DELETE' });
}

export function getStatus(period?: string): Promise<PeriodBudgetStatus[]> {
  const query = period !== undefined ? `?period=${encodeURIComponent(period)}` : '';
  return request(`/api/status${query}`);
}

export function getSummary(period?: string): Promise<SummaryResult> {
  const query = period !== undefined ? `?period=${encodeURIComponent(period)}` : '';
  return request(`/api/summary${query}`);
}
