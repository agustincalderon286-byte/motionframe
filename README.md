# Motionframe

An English, credit-based web experience for Kling 3.0 Motion Control. A visitor uploads one character image and one motion-reference video; the server keeps the KIE key private, creates the Kling task, and returns the finished video link.

## Run locally

Requires Node 20 or later. No package installation is necessary.

```bash
cp .env.example .env
npm run dev
```

Open `http://127.0.0.1:4173`.

Without `KIE_API_KEY`, the app runs in **demo mode**. It validates and safely stores a job locally, but does not send files or request a video from KIE.

## Enable real Kling generations

Set the following only in `.env`, never in browser code or Git:

```dotenv
KIE_API_KEY=your_private_key
STARTING_CREDITS=12
```

The server uploads the files to KIE, creates a `kling-3.0/motion-control` job, then polls its task endpoint. For a deployed site, set `PUBLIC_BASE_URL`, `KIE_CALLBACK_SECRET`, and `HOST=0.0.0.0`; KIE can then notify the callback URL when a job finishes. The app still polls as a fallback.

## What is complete now

- English customer-facing UI and responsive upload workflow
- Browser and server-side file checks: JPG/PNG up to 10 MB; MP4/MOV up to 100 MB
- Explicit rights/consent confirmation
- Private, server-only KIE integration with native `background_source`
- Persistent local credit balance and job history in `data/state.json`
- Task status polling, successful output link, and callback endpoint
- Demo mode when no KIE key is configured

## Before selling publicly

This local version deliberately does **not** have login, payments, production storage, or staff controls yet. The next production work should be:

1. Add authentication and a real database per customer.
2. Use Stripe Checkout webhooks to grant credits only after a confirmed payment.
3. Put uploads in private object storage with automatic deletion and signed download links.
4. Deploy the server behind HTTPS, rate limiting, logging, monitoring, and a privacy/terms flow.
5. Define refund/moderation rules before accepting public traffic.

Never use the `STARTING_CREDITS` environment variable as a payment system; it only provides local test credits.

## Stripe credit packs

Stripe Checkout is wired in but remains disabled until all required environment variables are set. In Stripe, create two one-time **Price** objects, then set their `price_…` IDs and the corresponding credit amounts:

```dotenv
PUBLIC_BASE_URL=https://your-service.onrender.com
STRIPE_SECRET_KEY=sk_live_or_test_…
STRIPE_WEBHOOK_SECRET=whsec_…
STRIPE_PRICE_STARTER=price_…
STRIPE_STARTER_CREDITS=15
STRIPE_PRICE_CREATOR=price_…
STRIPE_CREATOR_CREDITS=50
```

Add `https://your-service.onrender.com/api/stripe/webhook` as a Stripe webhook endpoint and subscribe it to `checkout.session.completed`. The server verifies Stripe’s signature and records each event ID so a successful payment grants credits only once. This first version has a single local account, so **do not activate live Stripe payments until user accounts and a production database are added**.
