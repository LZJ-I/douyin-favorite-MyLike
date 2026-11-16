import type { Account } from '../shared/contracts'
import { AppError } from './errors'

/** A lease belongs to one read-only scan, account and hidden browser document. */
export class ScanIdentity {
  private cached: { key: string; account: Account; at: number } | null = null
  private requestKey: string | null = null
  constructor(
    private readonly identify: (accountId: string, check: () => void) => Promise<Account>,
    private readonly sessionKey: (accountId: string) => string | null,
    private readonly ttl = 60_000,
    private readonly now = Date.now
  ) {}
  invalidate() {
    this.cached = null
    this.requestKey = null
  }
  async get(accountId: string, check: () => void): Promise<Account> {
    check()
    const key = this.sessionKey(accountId)
    if (
      this.cached &&
      key &&
      this.cached.key === key &&
      this.cached.account.id === accountId &&
      this.now() - this.cached.at < this.ttl
    ) {
      this.requestKey = key
      return this.cached.account
    }
    this.invalidate()
    const account = await this.identify(accountId, check)
    check()
    const after = this.sessionKey(accountId)
    if (key && key !== after) throw new AppError('PAGE_CHANGED', '扫描会话已变化，将在原断点重新核验身份。')
    this.requestKey = after
    if (after) this.cached = { key: after, account, at: this.now() }
    return account
  }
  assertCurrent(accountId: string) {
    if (this.requestKey && this.sessionKey(accountId) !== this.requestKey) {
      this.invalidate()
      throw new AppError('PAGE_CHANGED', '扫描会话已变化，当前页未保存，将在原断点重新核验身份。')
    }
  }
}
