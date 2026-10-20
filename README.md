# PymeOS

**Business management system for small retailers in Argentina** — point of sale,
multi-branch inventory, cash register, customer credit, purchasing, deliveries,
AFIP/ARCA electronic invoicing and an AI assistant that operates the system in
plain Spanish.

Built for a real two-branch footwear and sportswear retailer and currently being
rolled out in their stores. This public repository is a sanitized copy of the
production codebase: client name, addresses, infrastructure identifiers and all
credentials have been removed or replaced with demo values.

> The UI, domain language and code comments are in Spanish (the product's users
> are Argentine shop staff). This README is in English for reviewers.

---

## At a glance

| | |
|---|---|
| **Frontend** | TanStack Start (SSR) · React 19 · Tailwind CSS 4 · shadcn/ui · TanStack Query |
| **Backend** | Supabase — PostgreSQL, Row Level Security, Auth, Storage, Edge Functions (Deno) |
| **Database** | 55 versioned SQL migrations; business rules enforced in Postgres functions and triggers |
| **Fiscal** | AFIP/ARCA electronic invoicing (CAE) through a gateway, with webhook + reconciliation job |
| **AI** | Claude (Anthropic API) via an Edge Function with tool use and human confirmation |
| **Tests** | 65 tests — business logic plus database tests run against an in-process Postgres (PGlite) |
| **Hosting** | Vercel (app) + Supabase (data & functions) |

## Features

**Sales & POS** — sell, exchange sizes and sell on credit in a single atomic
operation. Exchanges are modeled as one sale with negative lines (not "void and
re-sell"), so history, cash and stock stay truthful. Prices and card surcharges
come from the database, never from the browser.

**Catalog & multi-branch stock** — one shared catalog, stock tracked per
*variant* (model × size × color) per branch. Stock is never edited directly:
every change is an immutable movement with who and when. Categories, sizes and
colors are picked from managed lists so data can't fragment ("Shoe" vs "Shoes").

**Cash register** — open with a counted float, close with a cash count; the
system shows expected vs. actual and records the difference and who closed.
Only cash payment methods touch the drawer (driven by a flag in the data, not
hard-coded).

**Customers & credit accounts** — running balances with a full ledger. Balances
can only change through database functions; manual corrections require the
owner role and a reason, and are recorded as offsetting entries, never edits.

**Purchasing & suppliers** — purchases add stock, record supplier debt and only
discount from the register what was paid in cash. Supplier orders show landed
cost and a **suggested price per unit** derived from historical category
margins and comparable products, with every number traceable to its source.

**Deliveries** — each delivery generates two links: one for the customer to
track the order on a map, one for the driver to publish their position from the
phone. No GPS service needed (OpenStreetMap + browser geolocation). A delivery
without a sale *reserves* stock instead of discounting it.

**Online catalog & orders**, **customer support inbox**, **expenses**,
**cheque portfolio**, **employees with role-based access and email invites**.

**Dashboard & P&L** — month-to-date figures compared against the *same slice*
of the previous month; profit computed on cost of goods sold (buying stock
doesn't count as an expense until it's sold). Month boundaries are computed in
local Argentine time, not server UTC.

**Electronic invoicing (AFIP/ARCA)** — invoice types A/B/C with fiscal
validation of customer tax status, CAE request through a gateway, webhook
receipt, a scheduled reconciliation job, printable ticket with the official QR
code, manual review flow and safe discarding of drafts with a full audit trail.

**AI assistant** — staff talk to it in Spanish and it does the work: look up
products, report sales, record an expense, a sale or a purchase. It can also
**read a photo or PDF of a supplier invoice** and draft the purchase, matching
each line to the catalog and asking about anything it couldn't read.
Read-only queries run directly; **anything that moves money or stock is shown
first and only executes after a human clicks Confirm**. It has no privileges of
its own: it acts with the session of the person using it, so the database
denies it exactly what it would deny that person. Usage is capped per user/day.

## Architecture & design decisions

```
 Browser (React SPA, SSR shell)
   │  publishable key only — safe by design
   ▼
 Supabase
   ├─ Postgres ── RLS on every table
   │              money/stock tables: no direct write grants
   │              → all writes go through SECURITY DEFINER functions
   ├─ Auth ────── per-person users, invitations, password recovery
   └─ Edge Functions (Deno) ── secrets live here, never in the bundle
        ├─ asistente ............. Claude + tools, runs as the caller
        ├─ facturar .............. requests CAE from the fiscal gateway
        ├─ arca-webhook .......... receives async invoice results (HMAC)
        ├─ sincronizar-comprobantes  reconciliation job (cron)
        └─ invitar-empleado ...... admin-only user invitations
```

A few rules shape almost everything else:

1. **Hiding a button is not security.** Every restriction in the UI also exists
   in the database via RLS and function checks. If a screen won't let you do
   something, neither will the API.
2. **Nothing is deleted; everything leaves a trail.** Products are deactivated,
   stock and ledger movements are immutable (triggers block `UPDATE`/`DELETE`).
   Mistakes are fixed with a visible offsetting movement.
3. **Money operations are atomic.** A sale is saved with one RPC call or not at
   all — there is no state where payments exist without the sale, or stock was
   discounted but the sale wasn't recorded.
4. **The active branch belongs to the device, not the user.** Each register is
   configured once; changing it requires an owner's password. Every movement is
   recorded against that branch.
5. **Secrets never reach the client.** Fiscal API keys, the Anthropic key and the
   service role key are Supabase secrets used only inside Edge Functions.

The data contracts written *before* the code — and the reasoning behind each
modeling decision — are in [`docs/`](docs):

- [`docs/contrato-catalogo.md`](docs/contrato-catalogo.md) — model vs. variant, stock per branch
- [`docs/contrato-ventas.md`](docs/contrato-ventas.md) — sales, payments, exchanges, credit
- [`docs/contrato-caja.md`](docs/contrato-caja.md) — register shifts, cash count, closing

## Project structure

```
src/
  routes/            one file per screen (ventas, stock, caja, facturacion, ...)
  components/        feature components + shadcn/ui primitives
  lib/
    asistente/       AI assistant: conversation, tool executor, invoice-photo drafts
    fiscal.ts        tax-status rules, invoice type selection
    comprobante-qr.ts  official AFIP QR payload
    sesion.tsx       session, role and active-branch context
supabase/
  migrations/        55 ordered migrations — schema, RLS, functions, triggers
  functions/         Edge Functions (Deno)
  seed/              demo catalog + its cleanup script
tests/               node:test suites; DB tests run migrations on PGlite
docs/                data contracts
```

## Running it locally

Requirements: Node 20+, a Supabase project (free tier is enough).

```bash
npm install
cp .env.example .env      # fill in your Supabase URL and publishable key
npm run dev
```

1. Apply the migrations in `supabase/migrations/` to your project
   (`supabase db push` with the Supabase CLI, or in order via the SQL editor).
2. Optionally load demo data: run `supabase/seed/demo_zapatillas.sql`.
3. Create your first user in Supabase Auth and give it the `dueno` (owner) role
   in `public.usuarios`.

Edge Functions need their own secrets, set with `supabase secrets set`:
`ANTHROPIC_API_KEY` (assistant), `ARCA_BASE_URL` / `ARCA_API_KEYS` /
`ARCA_WEBHOOK_SECRET` (invoicing), `CRON_SECRET` (reconciliation job),
`TOPE_ASISTENTE_DIA` (daily assistant cap). None are included in this repo.

```bash
npm test          # 65 tests (logic + database on PGlite)
npm run typecheck
npm run build
```

## How it was built — AI-assisted engineering

Designed and engineered by a two-person team using an AI-assisted workflow:
we own the architecture, data model, security model and every business
decision; AI coding agents implement scoped tasks under written team rules.
Data contracts are agreed *before* any code is written (see [`docs/`](docs)),
schema and money logic changes go through migrations and database tests, and
every change is reviewed through pull requests before it reaches `main`.

**Authors**
- **Ignacio Robles** — project lead; security, database design, fiscal and AI integrations
- **Joaquín Fontana** — backend

## License

Source published for portfolio and review purposes. All rights reserved —
please contact the authors before reusing it.
