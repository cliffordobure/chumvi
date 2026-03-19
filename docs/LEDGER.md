# Wallet Ledger Design (Fintech-Grade)

**Database:** MongoDB. Ledger entries and account balances are stored in `accounts` and `ledger_entries` collections. Balance changes use MongoDB transactions (replica set required for production).

## Why a ledger?

Updating a single `balance` column on every transaction leads to:

- **Race conditions** when two operations run at once
- **No audit trail** (you can’t prove how the balance was reached)
- **Lost updates** under high concurrency

Banks and payment providers (Stripe, Paystack) use **ledger-based accounting**: every movement of money is a **ledger entry**. The balance is always **derived** from the sum of entries.

## Model

### Accounts

- One **account** per Chama (type: `chama_wallet`).
- Optional: per-member or per-loan accounts if we extend (e.g. `member_loan`).

Fields:

- `id`, `chama_id`, `type`, `currency`, `balance_cents` (cached), `locked_balance_cents`, `updated_at`

### Ledger entries

Every financial event creates one or more **ledger entries** in a single DB transaction:

- `id`, `account_id`, `amount_cents` (positive = credit, negative = debit)
- `type`: e.g. `contribution`, `loan_disbursement`, `loan_repayment`, `dividend`, `withdrawal`, `penalty`
- `reference_type`, `reference_id` (e.g. contribution_id, loan_id)
- `balance_after_cents` (balance after this entry)
- `metadata` (JSON, optional)
- `created_at`

### Rules

1. **Single writer**: All balance changes go through one service (e.g. `ledgerService.recordEntry`) inside a DB transaction.
2. **Balance = sum(entries)**: The stored `balance_cents` on the account is a cache; it must equal the sum of entries. We can add a periodic reconciliation job.
3. **Idempotency**: For idempotent operations (e.g. payments), use a unique `idempotency_key` and skip if already applied.
4. **Locked balance**: Treated separately (e.g. `locked_balance_cents`) so “available” = balance - locked.

## Example flow: Contribution

1. Begin transaction.
2. Insert ledger entry: account_id = chama wallet, amount_cents = +2000, type = `contribution`, reference_id = contribution_id.
3. Update account: `balance_cents = balance_cents + 2000`.
4. Commit.

## Example flow: Loan disbursement

1. Begin transaction.
2. Insert ledger entry: account_id = chama wallet, amount_cents = -10000, type = `loan_disbursement`, reference_id = loan_id.
3. Update account: `balance_cents = balance_cents - 10000`.
4. Commit.

This keeps the chama wallet consistent and gives a full audit trail for every cent.
