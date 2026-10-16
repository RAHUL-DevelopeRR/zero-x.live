// Error raised by every account database driver. `message` carries the Postgres (or PostgREST)
// message so callers can match RPC errors such as /too_many_keys/; `code` is the SQLSTATE or
// PostgREST code. Never forward these messages to API clients.
export class AccountDatabaseError extends Error {
  constructor(message, { code = null, status = null, detail = null, hint = null } = {}) {
    super(message);
    this.name = 'AccountDatabaseError';
    this.code = code;
    this.status = status;
    this.detail = detail;
    this.hint = hint;
  }
}
