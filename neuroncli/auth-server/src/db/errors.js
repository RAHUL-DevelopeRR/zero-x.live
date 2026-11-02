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

// PostgREST (PGRST202) and Postgres (42883) codes for a function that does not exist, so the
// gateway keeps working on a database that lacks a newer, optional migration.
export const missingFunction = error => ['PGRST202', '42883'].includes(error?.code);
