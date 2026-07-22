# Auspicious-dates Panchang API setup

The Booking Calendar's "★" auspicious-date stars are sourced live from
[DivineAPI's Month Nakshatra List endpoint](https://developers.divineapi.com/indian-api/daily-panchang-api/month-nakshatra-list) —
a genuine, documented Panchang data provider. No dates are ever hardcoded
or invented in this codebase.

## How it works
- `server.ts` exposes `GET /api/auspicious-dates?year=YYYY`.
- It calls DivineAPI once per month (12 calls) for the requested year,
  requesting the real Moon-Nakshatra transit list for New Delhi.
- It marks a date auspicious **only** using two well-documented, widely
  verified Yoga rules (see e.g. drikpanchang.com/yoga/):
  - **Ravi Pushya Yoga** — Pushya Nakshatra falls on a Sunday.
  - **Guru Pushya Yoga** — Pushya Nakshatra falls on a Thursday.
- No other Yoga is approximated or guessed. Results are cached server-side
  for 24 hours per year to limit API usage.

## Required setup (yearly maintenance: none — one-time only)
Set these two environment variables on the server:
```
DIVINEAPI_API_KEY=your_divineapi_api_key
DIVINEAPI_AUTH_TOKEN=your_divineapi_auth_token
```
Get both from https://divineapi.com/api-keys. Once set, **every future
year works automatically** — no code changes, no data files, no manual
updates, ever.

## Failure behaviour (never fabricates data)
- Each month's API call has a **10-second timeout** and **retries up to 2
  times** (3 attempts total) with a short backoff on network errors, timeouts,
  or 5xx responses. A 4xx response (e.g. bad API key) is not retried.
- If the environment variables are not set: the endpoint returns
  `{ dates: {}, source: "unconfigured" }` and the calendar shows **no
  stars** — never invented ones.
- If a given month fails after all retries: that month is skipped (logged
  via `console.error`) and the rest of the year still loads normally.
- If the whole request fails: `{ dates: {}, source: "error" }` — again,
  no stars, never fabricated ones.

## Note on validation
This integration was built against DivineAPI's published API documentation.
It has **not** been tested against a live API key in this environment (no
test credentials were available). Please verify the returned dates against
a trusted source (e.g. drikpanchang.com) after configuring your API key,
before relying on this in production.
