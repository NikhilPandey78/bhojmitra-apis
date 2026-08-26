# BhojMitra Backend

Independent REST API for the BhojMitra partner portal. It uses a local SQLite database and JWT authentication.

## Setup

```bash
cd backend
cp .env.example .env
npm install
npm run dev
```

Required `.env` value: `JWT_SECRET`. Add `RESEND_API_KEY` to deliver demo booking emails.

## API

Public:
- `GET /health`
- `POST /api/demo-requests`
- `POST /api/contact-queries`

Authenticated with `Authorization: Bearer <jwt-token>`:
- `GET /api/me`
- `GET /api/dashboard`
- `GET /api/subscription`
- `PATCH /api/subscription`
- `GET /api/invoices`
- `GET /api/notifications`
- `PATCH /api/notifications/:id/read`
- `GET /api/documents`
- `POST /api/documents`
- `DELETE /api/documents/:id`
- `GET /api/support/tickets`
- `POST /api/support/tickets`
- `GET /api/support/tickets/:id`
- `POST /api/support/tickets/:id/replies`
