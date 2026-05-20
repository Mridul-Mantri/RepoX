# RepoX Backend

**India's repossessed asset liquidation infrastructure.**
A B2B2C marketplace connecting banks/NBFCs, retail buyers, and bulk
dealers/fleet operators for transparent online auctions and instant-buy sales
of repossessed vehicles.

Built with **NestJS · PostgreSQL · Prisma · Redis · Socket.io · Razorpay**.

---

## What's in here

| Capability | Where |
|---|---|
| Bank uploads vehicles, runs auctions, lists lots | `vehicles`, `lots` modules |
| Buyer browses, bids, reserves, pays | `vehicles`, `bids`, `orders` modules |
| 10-minute hold prevents double-booking | `vehicles.service.ts` (Redis lock + Postgres conditional update) |
| Real-time bidding with anti-snipe | `bids.service.ts` + Socket.io gateway |
| Razorpay checkout + signature verify + webhooks | `payments` module |
| QR pickup pass + OTP handover at bank counter | `pickup` module |
| Enterprise RFQ procurement workflow | `rfqs` module |
| Bank dashboard, buyer dashboard, super-admin dashboard | `banks`, `users`, `admin` modules |
| Sliding-window fraud detection | `redis.service.ts` + service-level checks |
| Full audit log of every action | `activity` module |

---

## Architecture

### Concurrency: how we guarantee "no double-booking"

This is the single most important property of the platform. Two buyers click
"Buy Now" on the same SUV in the same second. Two bidders submit bids of equal
amount within milliseconds. The system must pick exactly one winner and tell
the other "sorry, gone" — **never** sell the same vehicle to two people.

We solve this with **defence in depth**:

1. **Redis distributed lock (Redlock)** around any state transition on a
   vehicle/lot. A second API pod waiting on the same lock simply queues. See
   `RedisService.withLock()`.
2. **Conditional Postgres update** inside the lock. We `UPDATE … WHERE
   currentBidPaise = <what-we-read>` (optimistic concurrency). If 0 rows are
   affected, someone else already changed it — we throw `409 Conflict`.
3. **Hold timestamp on the row.** `status=ON_HOLD` plus `heldUntil=<10min>`.
   A `@Cron(EVERY_MINUTE)` job sweeps expired holds back to LIVE.
4. **App-level rate limit** + **sliding-window fraud counter in Redis** so
   one user can't spam holds or bids.
5. **Final settlement is the Postgres row.** Realtime broadcasts (Socket.io)
   are notifications, never the source of truth.

The result: even if Razorpay returns success and the user's browser hangs,
the hold sweep returns the vehicle to market 10 minutes after the hold was
issued — and the order row is marked `EXPIRED` so the user can't accidentally
pay later for a vehicle that's already been resold.

### Money

Every monetary value in the database is stored as **BigInt paise** (1 INR =
100 paise). Floats are forbidden. Conversion + fee math lives in
`src/common/utils/money.ts`. The `Money.computeOrderTotals()` helper does
fee % → fee paise → GST on fee → total, always rounding at the final paise.

### Realtime

Socket.io with the **Redis adapter** so multiple Nest pods broadcast to the
same set of connected clients (otherwise pod-A's `bid:new` wouldn't reach a
buyer connected to pod-B). Rooms:

- `vehicle:<id>` — everyone watching one vehicle
- `lot:<id>` — bulk buyers watching a lot
- `user:<id>` — that user's private events (outbid, KYC reviewed, etc.)
- `bank:<id>` — bank staff dashboard
- `admin` — live activity feed for super-admins

Frontends connect at `/realtime` namespace with the JWT in the handshake.

### Auth

JWT access tokens (7 days) + **rotating** refresh tokens (30 days) stored
hashed in `refresh_tokens`. Roles: `BUYER`, `BANK_STAFF`, `ADMIN`,
`SUPER_ADMIN`. Buyer sub-tiers: `RETAIL`, `DEALER`, `ENTERPRISE` — used to
pick the platform fee % and gate the RFQ feature.

App-wide guards (`JwtAuthGuard`, `RolesGuard`, `KycGuard`) are registered as
`APP_GUARD` in `AuthModule`, so every endpoint is protected by default. Mark
public routes with `@Public()`, role-restricted with `@Roles(...)`, and
buyer-actions-that-require-verified-identity with `@RequireKyc()`.

---

## Local development

### Prerequisites
- Node.js 20+
- Docker + Docker Compose (or your own Postgres 16 + Redis 7)

### One-time setup

```bash
cp .env.example .env
# Edit .env — set JWT_SECRET, JWT_REFRESH_SECRET (32+ chars each).
# For dev, RAZORPAY_KEY_ID can stay as the placeholder and the backend
# will run in "mock mode" — no real charges.

# Bring up Postgres + Redis (skip if you have them locally)
docker compose up -d postgres redis

npm install
npm run prisma:generate
npm run prisma:migrate     # creates schema
npm run prisma:seed        # populates demo data
```

### Run

```bash
npm run start:dev
```

The API is at `http://localhost:5000/api/v1`. Swagger docs at
`http://localhost:5000/api/docs`.

### Demo credentials (after seed)

All accounts use password `password123`.

| Role | Email |
|---|---|
| Super admin | `admin@repox.in` |
| HDFC bank staff | `staff@hdfc.repox.in` |
| ICICI bank staff | `staff@icici.repox.in` |
| Bajaj Finance staff | `staff@bajaj.repox.in` |
| Retail buyer (KYC done) | `rahul@example.com` |
| Dealer (KYC done) | `sunil@krishnamotors.in` |
| Enterprise (KYC done) | `procurement@swiftfleet.in` |
| Pending KYC buyer | `newbuyer@example.com` |

### Run with the full Docker stack

```bash
docker compose up --build
# API on :5000, Postgres on :5432, Redis on :6379
```

---

## API surface (highlights)

Every endpoint is prefixed `/api/v1`.

### Auth
```
POST   /auth/register              Register (buyer self-service)
POST   /auth/login                 Login
POST   /auth/refresh               Rotate refresh token → new access token
POST   /auth/logout                Revoke refresh tokens
GET    /auth/me                    Current user
```

### Vehicles (public listings + bank uploads + the critical hold endpoint)
```
GET    /vehicles                   Search/filter/paginate marketplace
GET    /vehicles/:id               Detail
POST   /vehicles                   (BANK_STAFF) Create listing
PATCH  /vehicles/:id               (BANK_STAFF) Update listing
POST   /vehicles/:id/hold          (BUYER + KYC) Reserve for 10 min
```

### Bids
```
POST   /bids/vehicle/:vehicleId    Place bid (Redis lock + anti-snipe)
POST   /bids/lot/:lotId            Place bid on a lot
GET    /bids/vehicle/:vehicleId    Bid history
GET    /bids/mine                  Current user's bids
```

### Lots (bulk auctions)
```
GET    /lots                       Browse open/private lots
GET    /lots/:id                   Detail with vehicle list
POST   /lots                       (BANK_STAFF) Create lot
POST   /lots/:id/request-access    (BUYER) Request access to private lot
POST   /lots/:id/approve-bidder/:userId   (BANK_STAFF) Approve
```

### Orders (checkout + payment verify)
```
POST   /orders/checkout            Create order + Razorpay order
POST   /orders/:id/verify-payment  Verify HMAC, mark PAID, generate QR
GET    /orders/mine                Buyer's orders
GET    /orders/:id                 Detail (buyer / bank-owner / admin only)
```

### Pickup (bank-side verification)
```
POST   /pickup/scan                (BANK_STAFF) Scan QR → emits OTP to buyer
POST   /pickup/:orderId/complete   (BANK_STAFF) Submit OTP → status COLLECTED
GET    /pickup/pending             (BANK_STAFF) Today's pickup queue
```

### RFQs (enterprise procurement)
```
POST   /rfqs                       (DEALER | ENTERPRISE) Post RFQ
GET    /rfqs/mine                  Buyer's RFQs with responses
GET    /rfqs/incoming              (BANK_STAFF) Open RFQs to respond to
POST   /rfqs/:id/respond           (BANK_STAFF) Quote
POST   /rfqs/:rfqId/accept/:responseId   (BUYER) Accept a quote
```

### Users (profile + KYC + saved + notifications)
```
GET    /users/me
PATCH  /users/me
POST   /users/me/kyc               Submit KYC documents
GET    /users/me/saved             Watchlist
POST   /users/me/saved/:vehicleId
DELETE /users/me/saved/:vehicleId
GET    /users/me/notifications
PATCH  /users/me/notifications/:id/read
```

### Banks
```
GET    /banks
GET    /banks/:id
POST   /banks                      (ADMIN)
PATCH  /banks/:id                  (ADMIN)
GET    /banks/me/dashboard         (BANK_STAFF) Stats + recent activity
```

### Admin
```
GET    /admin/overview             Platform KPIs
GET    /admin/kyc/pending          KYC queue
PATCH  /admin/kyc/:userId          Approve/reject KYC
GET    /admin/fees
POST   /admin/fees                 Change platform fee for a tier
GET    /admin/fraud-alerts
PATCH  /admin/fraud-alerts/:id     Resolve
GET    /admin/users
PATCH  /admin/users/:id/deactivate
POST   /admin/users/bank-staff     Provision bank-staff account
```

### Payments
```
POST   /payments/webhook/razorpay  Async Razorpay events (signature-verified)
```

---

## Razorpay setup

For local development you can leave the placeholder `rzp_test_xxxx...` keys
in `.env` — the backend detects this and runs in **mock mode**: it generates
fake `order_mock_*` IDs, and signature verification always passes. The full
flow is still exercised end-to-end including QR generation and pickup.

For production:

1. Sign up at razorpay.com → activate live mode.
2. Set real `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET` in your environment.
3. Configure a webhook in the Razorpay dashboard pointed at
   `https://api.repox.in/api/v1/payments/webhook/razorpay`, with events
   `payment.captured`, `payment.failed`, `refund.processed`.
4. Set the webhook secret as `RAZORPAY_WEBHOOK_SECRET`.

The webhook handler is idempotent — every event is persisted by Razorpay's
`event_id` to prevent replay.

---

## Deployment (AWS sketch)

```
Internet
   │
   ▼
ALB ────► ECS Fargate service (2+ tasks of the API container)
              │
              ├──► RDS Postgres (multi-AZ)
              ├──► ElastiCache Redis (cluster mode disabled is fine for
              │     Redlock with a single shard; switch to clustered with
              │     multi-node RedLock for true HA)
              └──► CloudWatch logs + metrics
```

- The Dockerfile is multi-stage; the runtime image is small (~150 MB).
- `npx prisma migrate deploy` runs on container start. In a serious pipeline,
  run migrations as a one-off pre-deploy step instead.
- Run **at least 2 API tasks**. The Socket.io Redis adapter handles fanout
  between them. The hold/bid Redis locks ensure they don't trample each other.

---

## Project structure

```
src/
├── main.ts                              # bootstrap, Swagger, Redis IO adapter
├── app.module.ts                        # wires everything
├── common/
│   ├── prisma/                          # PrismaService + module
│   ├── redis/                           # RedisService with Redlock + sliding-window
│   ├── decorators/                      # @CurrentUser, @Roles, @Public, @RequireKyc
│   ├── guards/                          # JWT + Roles + KYC guards (global)
│   ├── filters/                         # HTTP + Prisma exception filters
│   └── utils/                           # Money, codes, BigInt JSON patch
└── modules/
    ├── auth/                            # register, login, JWT, refresh
    ├── users/                           # profile, KYC, saved, notifications
    ├── banks/                           # bank CRUD + bank dashboard
    ├── vehicles/                        # marketplace + hold + cron
    ├── bids/                            # vehicle + lot bidding
    ├── lots/                            # bulk auctions
    ├── orders/                          # checkout + verify + fee service
    ├── payments/                        # Razorpay client + webhooks
    ├── pickup/                          # QR + OTP handover at branch
    ├── rfqs/                            # enterprise RFQs
    ├── admin/                           # KYC review, fees, fraud, users
    ├── activity/                        # audit log (used by everyone)
    └── realtime/                        # Socket.io gateway + Redis adapter
prisma/
├── schema.prisma                        # full data model
└── seed.ts                              # demo data
```

---

## What's intentionally out of scope (yet)

- **SMS gateway integration** for the pickup OTP. The OTP is generated and
  hashed server-side; in dev it's also returned in the API response and
  logged so you can test the flow. Wire up Twilio / MSG91 / Karix in
  `PickupService.scan()`.
- **PDF invoice rendering**. The `Invoice` row is created at payment capture;
  `pdfUrl` is null. Add a worker (e.g. BullMQ) that renders and uploads to S3.
- **S3 image uploads**. Vehicle images are stored as URLs; the upload flow
  should sign S3 PUT URLs and return them to the frontend.
- **Tests**. Test scaffolding is in `package.json`. Write Jest tests for the
  hold + bid services first — they're the most concurrency-sensitive.

---

## License

Proprietary. © RepoX, 2026.
