# Support Ticket System

Standalone support ticket app with:

- Superadmin login gate for the full web app
- Protected dashboard at `/tickets`
- Admin-only employee credential page at `/admin/employees`
- PostgreSQL + Prisma ready data layer
- Soft delete and audit logging
- Real-time updates with Socket.IO
- Browser notifications for new tickets
- Authenticated inbound API for CRM/SaaS integrations
- Optional outbound webhook for pushing events to another system
- Legacy JSON fallback when `DATABASE_URL` is not configured

## Run locally

```bash
npm install
npm run prisma:generate
npm start
```

This project now reads settings from a local `.env` file automatically.

Default local file:

```env
PORT=3002
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/support_ticket_system?schema=public
DATABASE_SSL_MODE=disable
DATABASE_SSL_REJECT_UNAUTHORIZED=false
INBOUND_API_KEY=your-secret-key
OUTBOUND_WEBHOOK_URL=
SUPERADMIN_USERNAME=replace-with-a-non-default-admin-username
SUPERADMIN_PASSWORD=replace-with-a-strong-password-at-least-12-characters
SUPERADMIN_PASSWORD_HASH=
SESSION_SECRET=replace-with-a-long-random-session-secret
BREVO_API_KEY=
BREVO_SENDER_EMAIL=
BREVO_SENDER_NAME=Triverse Support
BREVO_SMTP_LOGIN=
BREVO_SMTP_KEY=
BREVO_SMTP_HOST=smtp-relay.brevo.com
BREVO_SMTP_PORT=587
```

If you ever want to rotate the key manually, update `.env`.

PowerShell override if needed:

```powershell
$env:INBOUND_API_KEY="replace-this-with-a-secret"
$env:OUTBOUND_WEBHOOK_URL="https://your-crm-or-saas.example.com/webhooks/tickets"
$env:SUPERADMIN_USERNAME="superadmin"
$env:SUPERADMIN_PASSWORD="replace-this-with-a-strong-password"
$env:SUPERADMIN_PASSWORD_HASH=""
$env:SESSION_SECRET="replace-this-with-a-random-string"
$env:DATABASE_URL="postgresql://postgres:postgres@localhost:5432/support_ticket_system?schema=public"
$env:BREVO_API_KEY="xkeysib-..."
$env:BREVO_SENDER_EMAIL="support@yourdomain.com"
$env:BREVO_SENDER_NAME="Triverse Support"
$env:BREVO_SMTP_LOGIN="your-brevo-smtp-login"
$env:BREVO_SMTP_KEY="xsmtpsib-..."
npm start
```

Open:

- `http://localhost:3002/login` to sign in as the superadmin
- `http://localhost:3002/` to open the protected support dashboard after login

## Notes

- Prisma schema lives in `prisma/schema.prisma`
- Initial SQL migration lives in `prisma/migrations/0001_init/migration.sql`
- When `DATABASE_URL` is set, tickets and audit logs use PostgreSQL via Prisma
- PostgreSQL SSL is controlled explicitly with `DATABASE_SSL_MODE` instead of being forced by `NODE_ENV`
- When `DATABASE_URL` is missing, the app falls back to `src/data/tickets.json` and `src/data/audit-log.json`
- All web routes now require the configured superadmin login
- Sessions use PostgreSQL when `DATABASE_URL` is set, otherwise the in-memory fallback is used
- CSRF protection is enabled for web form submissions and dashboard mutations
- Login requests are rate-limited
- Inbound integrations post to `/api/inbound/tickets` with `x-api-key`
- Browser notifications need to be enabled from the dashboard button
- If `OUTBOUND_WEBHOOK_URL` is set, every new or updated ticket is forwarded there
- Brevo API mode: use `BREVO_API_KEY=xkeysib-...` with `BREVO_SENDER_EMAIL`
- Brevo SMTP mode: use `BREVO_SMTP_LOGIN` plus `BREVO_SMTP_KEY=xsmtpsib-...` with `BREVO_SENDER_EMAIL`
- Every ticket status change will email the requester when one valid Brevo mode is configured
- Employee credentials can be provisioned from `/admin/employees`; each submission generates a fresh temporary password, stores its hash, and emails the credentials to the employee

## Deployment Readiness

Production boot now fails fast if any of these are missing or unsafe:

- `DATABASE_URL`
- `SESSION_SECRET` with a strong non-default value
- `INBOUND_API_KEY` with a non-default value
- `SUPERADMIN_USERNAME` changed from the default
- `SUPERADMIN_PASSWORD` or `SUPERADMIN_PASSWORD_HASH`

Recommended deploy sequence:

1. Provision PostgreSQL and set `DATABASE_URL`.
2. If your provider requires TLS, set `DATABASE_SSL_MODE=require`. If it does not, keep `DATABASE_SSL_MODE=disable`.
3. Set `NODE_ENV=production` and all required secrets.
4. Run `npm run prisma:generate`.
5. Run `npm run prisma:migrate:deploy`.
6. Start the app with `npm start`.

Health endpoint:

- `GET /api/health` returns `200` only when the app is ready for traffic.
- It returns `503` when production config is invalid or PostgreSQL is unreachable.

## PostgreSQL Setup

1. Create a PostgreSQL database.
2. Set `DATABASE_URL` in `.env`.
3. Run:

```bash
npm run prisma:generate
npm run prisma:migrate:dev
```

4. Start the app with `npm start`.

If you are migrating from the old JSON store, the app imports legacy tickets into PostgreSQL on first boot when the database is empty.

## Inbound API

Endpoint:

- `POST http://localhost:3002/api/inbound/tickets`

Headers:

- `Content-Type: application/json`
- `x-api-key: your-secret-key`

Body:

```json
{
  "name": "Riya Sharma",
  "email": "riya@example.com",
  "subject": "Payment not reflected",
  "category": "Payments",
  "priority": "high",
  "message": "I completed the payment but the dashboard still shows pending.",
  "source": "leadvora-crm",
  "externalId": "crm-ticket-1042",
  "metadata": {
    "leadId": "LD-8831",
    "owner": "Admissions Team"
  }
}
```

Example `curl`:

```bash
curl -X POST http://localhost:3002/api/inbound/tickets \
  -H "Content-Type: application/json" \
  -H "x-api-key: your-secret-key" \
  -d "{\"name\":\"Riya Sharma\",\"email\":\"riya@example.com\",\"subject\":\"Payment not reflected\",\"category\":\"Payments\",\"priority\":\"high\",\"message\":\"I completed the payment but the dashboard still shows pending.\",\"source\":\"leadvora-crm\",\"externalId\":\"crm-ticket-1042\"}"
```

Notes:

- `name`, `email`, `subject`, and `message` are required
- `source` identifies which system sent the ticket
- `externalId` prevents duplicates when the same CRM record is retried
- Valid priorities are `low`, `medium`, `high`, and `urgent`

## CRM Wiring

Use this when you want your CRM to create tickets here:

1. Expose this app on a reachable URL, such as `https://support.yourdomain.com`.
2. Set a strong `INBOUND_API_KEY` before starting the server.
3. In your CRM automation or backend, call `POST /api/inbound/tickets`.
4. Map CRM fields like this:
   CRM contact name -> `name`
   CRM email -> `email`
   CRM issue title -> `subject`
   CRM issue description -> `message`
   CRM department/type -> `category`
   CRM priority -> `priority`
   CRM record ID -> `externalId`
   Constant like `leadvora-crm` -> `source`
5. Open the dashboard at `/tickets` in your browser and enable notifications.

If your CRM supports webhooks only:

- Create a small middleware step in Node, n8n, Make, or Zapier
- Receive the CRM webhook
- Transform the payload into the JSON body above
- Forward it to `/api/inbound/tickets` with `x-api-key`

## Future SaaS Wiring

If this becomes your SaaS later, keep this app as the ticket service and treat everything else as clients:

1. Keep `/api/inbound/tickets` as the stable public API for all products.
2. Give each product its own `source` value, like `crm`, `student-portal`, `mobile-app`, or `partner-dashboard`.
3. Store each upstream record ID in `externalId` so retries stay idempotent.
4. Point `OUTBOUND_WEBHOOK_URL` to your central SaaS backend if you want this app to push ticket events out.
5. Move storage from `src/data/tickets.json` to a real database when you are ready, while keeping the same API contract.

Recommended production path:

- Phase 1: Use this app standalone with the dashboard open
- Phase 2: Connect CRM automations to `/api/inbound/tickets`
- Phase 3: Replace JSON storage with PostgreSQL or MongoDB
- Phase 4: Add user accounts, roles, email/WhatsApp alerts, and SLA reporting
