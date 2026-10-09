# ClipBridge 文桥

[English](./README.md) | [简体中文](./README.zh-CN.md)

> Text sync between your devices, on Cloudflare Workers — QR codes carry text into the phone, claim codes bring it back to the PC. One source file, zero cost.
> Deploy it once and get `https://qr-generator.<your-subdomain>.workers.dev`, served from edge nodes worldwide (the Worker keeps the name `qr-generator` for compatibility with already-generated codes).

## Features

- **SVG output** — crisp at any resolution, returned as `image/svg+xml` with 1-day browser caching
- **Styleable** — module pixel size, quiet-zone margin, foreground/background colors, error-correction level
- **Built-in playground** — visiting the root URL without `?text=` serves a minimal form page
- **Copy bridge by default** — every code encodes a short link to a transfer page where the scanner chooses to copy, open or share; `mode=text` encodes raw content instead
- **Claim-code transfer** — `/send` turns pasted text into a 4-character claim code; open `/r/<code>` anywhere to receive it. No camera needed, works in every direction (phone ↔ PC), up to 32 KB, self-destructs after 10 minutes or on first read
- **Small-file transfer** — the same claim codes carry files up to 25 MB (drag & drop on `/send`); the receiver gets a download page, fully compatible with multi-threaded mobile download managers
- **One-tap copy-link button** — the sender's result card copies the claim URL to the clipboard with **🔗 复制取件链接**, ready to paste into a chat; you never have to open the link yourself (opening it consumes the text claim). Falls back to `document.execCommand` without the Clipboard API, and always gives visible feedback
- **Fault-tolerant** — out-of-range numbers are clamped, invalid colors fall back to defaults; bad input never causes a 500
- **Clipboard channel** — `/c` pairs two devices once (scan the QR), then they share a persistent clipboard: whatever either side sends appears on the other within ~4 seconds, text or files, no claim code to retype. Keeps the 20 most recent items for 24 hours
- **CORS-ready** — `Access-Control-Allow-Origin: *`, so the API can be embedded from any origin
- **No moving parts** — the only state is Workers KV (claim codes and channel items): no database, no R2, no Durable Objects. Runs comfortably inside the Workers free tier

## Quick Start

Prerequisites: Node.js ≥ 18 (check with `node -v`) and a free [Cloudflare account](https://dash.cloudflare.com).

```bash
npm install
npx wrangler login   # one-time browser authorization
npm run dev          # local dev server at http://localhost:8787
npm run deploy       # ship to https://qr-generator.<your-subdomain>.workers.dev
npm run tail         # stream production logs
```

Roll back a bad deploy with `npx wrangler rollback` (deployment history is kept automatically).

## API

### Endpoints overview

| Route | Method | Purpose |
| --- | --- | --- |
| `/` | GET | Home transfer and claim page; with `?text=` returns the SVG QR |
| `/qr` | GET | Standalone QR generator page |
| `/t?d=…` | GET | Bridge page where a scanned copy-code lands |
| `/send` | GET | Claim-code sender page (matches home page) |
| `/r` | GET | Claim-code input page (auto-claims at 4 characters) |
| `/r/:code` | GET | Claim a transfer — text burns on read; files stay claimable until TTL |
| `/r/:code/download` | GET | Download a claimed file |
| `/c` | GET | Clipboard-channel pairing page (create or join) |
| `/c/:code` | GET | Clipboard-channel room — scanning the QR pairs the device automatically |
| `/c/:code/e/:id` | GET | Raw text or file download for one channel item |
| `/api/transfer` | POST | Create a transfer — JSON body for text, raw bytes + `x-file-name` header for files |
| `/api/channel` | POST | Create a channel (`{"action":"create"}`) or send to it (JSON `{"action":"send",…}` / raw bytes + `x-channel-code`) |
| `/api/channel/:code` | GET | Poll a channel — `?since=<seq>` returns only newer items |
| `/api/channel/:code` | DELETE | Destroy a channel and every payload it still indexes |
| `/favicon.svg` | GET | Site icon |

### QR generation

```
GET /?text=...&size=...&margin=...&color=...&bg=...&ecl=...
```

| Param | Type | Default | Description |
| --- | --- | --- | --- |
| `text` | string, **required** | — | Content to encode. **Must be URL-encoded**; up to 2 000 characters |
| `size` | int 1–20 | `8` | Pixel size of each module |
| `margin` | int 0–10 | `2` | Quiet zone around the code, in modules |
| `color` | `#RGB` / `#RRGGBB` / `#RRGGBBAA` | `#000000` | Foreground color |
| `bg` | same formats | `#ffffff` | Background color |
| `ecl` | `L` / `M` / `Q` / `H` | `M` | Error-correction level: higher survives more occlusion but holds less data |
| `mode` | `text` | bridge | `text` encodes the raw content directly; omit for the default bridge behavior (see "Copy bridge") |

Responses:

- **Success** — `200`, `image/svg+xml`, with `Cache-Control: public, max-age=86400` and `Access-Control-Allow-Origin: *`
- **Bad request** — `400`, `application/json`, e.g. `{"error":"参数 text 不能为空"}` ("parameter `text` cannot be empty"; error bodies are in Chinese)
- **No `text` param** — `200`, `text/html`, the built-in playground page

### Examples

```bash
BASE=http://localhost:8787   # or the workers.dev URL after deploy

# A URL (percent-encoding done by hand here)
curl -s "$BASE/?text=https%3A%2F%2Fgithub.com" -o qr.svg

# Chinese text — curl's --data-urlencode handles encoding
curl -sG "$BASE/" --data-urlencode "text=你好，世界" -o zh.svg

# Wi-Fi join code with higher error correction
curl -sG "$BASE/" \
  --data-urlencode 'text=WIFI:T:WPA;S:Home;P:12345678;;' \
  --data-urlencode 'ecl=Q' -o wifi.svg

# Styled: bigger modules, custom color
curl -sG "$BASE/" \
  --data-urlencode "text=https://example.com" \
  --data-urlencode "size=12" --data-urlencode "color=#4A90D9" -o styled.svg
```

### Copy bridge (text → phone in one tap)

Every code is a bridge code by default: instead of the raw text it encodes a short link back to this service (e.g. `https://qr.example.com/t?d=…`). Scanning it opens a minimal transfer page with an explicit choice: **📋 Copy all**, **🔗 Open link** (only when the payload looks like a URL), or **📤 Share** — the system share sheet, which pastes the text straight into any app (shown only where `navigator.share` is supported). Nothing is written to the clipboard until the user taps **Copy all** — no background or tap-anywhere copying. The choice belongs to whoever scans, not whoever generates — pass `mode=text` if you need the old direct encoding (e.g. for print longevity or offline use).

- Data rides entirely in the URL (base64url, `deflate-raw` compressed whenever that is shorter) — the server decodes nothing and stores nothing.
- The bridge URL is capped at 1 500 bytes; anything longer automatically falls back to a plain-text code.
- Caveats: the payload is visible to anyone holding the link and ends up in browser history — don't bridge secrets. The clipboard API requires a user gesture and a secure context (HTTPS), hence the explicit buttons plus a silent auto-copy attempt.

### Claim-code transfer (any device, any direction)

Scanning needs a camera on the receiving side, which phones have and PCs rarely use. For the other direction — phone → PC, or PC → PC — use claim codes:

1. Open `/send`, paste the text (up to 32 KB), tap **生成取件码**.
2. You get a 4-character code (e.g. `K7X2`), a claim URL, and a QR of that URL — plus a **🔗 复制取件链接** button that copies the URL straight to the clipboard for pasting into a chat.
3. On any other device, reach it any of three ways: open `https://qr.example.com/r/K7X2` directly, scan the QR, or enter `K7X2` directly below the homepage (or at `/r`) — claiming fires automatically once 4 characters are in.

Notes: the code is stored in Workers KV with a 10-minute TTL. **Text burns on first read**, so a leaked or stale code is worthless. The receiver page is the same bridge page served with the payload inlined — no redirect, no URL-length limits. KV free tier allows 1 000 writes/day, far beyond personal use.

**Files** ride the exact same flow: pick or drop a file on `/send` (up to 25 MB, the KV value limit), and the receiver sees a download page with the file name and size. Files do **not** burn on download — they stay claimable until the 10-minute TTL expires, because mobile download managers fire multi-request patterns (security pre-fetches, `Range: bytes=0-` probes, multi-threaded chunks, retries) that make instant-burn semantics self-defeating. The download route fully supports `Range` (`206 Partial Content`) and `HEAD` so Quark/UC-style managers work, file names and MIME types are preserved (`Content-Disposition` uses RFC 5987 for non-ASCII names), and the anchor carries the `download` attribute. Text keeps its stricter burn-after-read.

### Clipboard channel (pair once, then stop retyping codes)

Claim codes are perfect for one-off transfers, but sending five things in a row means reading out five codes. A **clipboard channel** is a small paired room instead:

1. Open `/c` on the device you have in hand, tap **创建新频道** (create channel). You get an 8-character code and a QR.
2. Scan that QR with the other device (or paste the code / the `/c/<code>` link into its browser once). Both ends now remember the channel in `localStorage`.
3. From then on: paste text and tap **发送**, or pick a file — it shows up on the other device within about 4 seconds, with a **📋 复制** button that puts the text on that device's system clipboard. Send in either direction; both ends poll the same room.

Notes:

- The room keeps the **20 most recent items for 24 hours** (each new item refreshes the clock) and the server holds a short preview (≤120 characters) plus a pointer per item — the full text or file is fetched per item when you open or copy it, which keeps polling cheap. Text sent to a channel does **not** burn on read, unlike a claim code.
- Nothing is ever copied to your clipboard silently. Browsers (iOS Safari especially) only allow clipboard writes inside a real tap, so the copy button prefetches its payload and copies synchronously when tapped.
- Two devices sending in the same second can very occasionally lose one item (KV reads and writes are eventually consistent and not transactional) — the room is a convenience channel, not a sync engine. Keep using claim codes for anything you cannot afford to lose.
- **离开** (leave) only forgets the channel on this device; **销毁频道** (destroy) deletes it for both, including the payloads it still indexes. Items pushed out of the 20-item window stop being reachable from the room but their KV entries can linger until the 24-hour TTL.
- Channel codes are 8 characters from the same unambiguous alphabet as claim codes (`A–Z` minus `I`, `L`, `O` and digits `0`, `1`), so they are readable aloud and never collide with the 4-character claim space (separate KV key prefix `c:` vs `t:` — the existing flows are untouched).
- Polling costs roughly 1 read per device per interval (`~900/hour` at 4 s), well under the KV free tier; a busy room is still one key, so it never touches the 1 000 list/day budget.

### Handy payload formats

```text
# Wi-Fi (T: WPA / WEP / nopass)
WIFI:T:WPA;S:network-name;P:password;;

# Phone / SMS / email
tel:+8613800000000
SMSTO:+8613800000000:message text
mailto:hi@example.com?subject=hello

# Contact card, vCard 3.0 (line breaks encoded as %0A)
BEGIN:VCARD%0AVERSION:3.0%0AFN:Jane%0ATEL:+8613800000000%0AEND:VCARD
```

## Behavior & Limits

- `text` is capped at 2 000 characters; anything longer gets a `400`. There is **no silent truncation** — a truncated code would scan to the wrong content.
- Values that can be tolerated are tolerated: oversized `size`/`margin` are clamped, invalid colors fall back to the defaults, unknown `ecl` falls back to `M`. Only an empty `text`, an over-long `text`, or content the encoder genuinely cannot fit return `400`.
- Remember to URL-encode the `text` value (`&`, `#`, spaces and non-ASCII all need it) — this is the number-one integration gotcha.
- A QR code encodes, it does not encrypt: anyone can scan it. Don't put secrets in it (use a guest network for Wi-Fi codes).

## Deployment Notes

- **Custom domain (optional)** — if your domain's DNS is on Cloudflare, add to `wrangler.jsonc`, then redeploy; the certificate is issued automatically:
  ```jsonc
  "routes": [{ "pattern": "qr.example.com", "custom_domain": true }]
  ```
- **Free tier** — about 100 000 requests/day and 10 ms CPU per invocation (as of 2026-09, check Cloudflare's pricing page). This toy uses a tiny fraction of either.
- **Reachability** — `workers.dev` subdomains can be unreliable inside mainland China; a custom domain usually helps.

## Project Structure

```text
qr-generator/
├── src/index.ts      # the entire service: parse params → uqr renderSVG / bridge page / channel page → respond
├── wrangler.jsonc    # Worker configuration
├── package.json
├── tsconfig.json
├── docs/             # design notes: clipboard-share-plan.md compares the channel options
├── tests/            # end-to-end suites (transfer, file, regression, channel)
├── README.md         # this file
└── README.zh-CN.md   # Chinese documentation
```

## Implementation Notes

Small, deliberate deviations from the original implementation doc:

1. `@cloudflare/workers-types` is `^5` — the current wrangler v4 declares it as a peer dependency, and the doc's `^4` fails `npm install`.
2. Text over 2 000 characters returns `400` instead of being silently truncated. The doc asked for both truncation *and* a `400` on 3 000 characters, which contradict each other; the `400` behavior is the safer one for users.

## Testing

The suites in [`tests/`](./tests) are stateful end-to-end tests: they create real transfers in the target's KV (cleaned up by the 10-minute TTL), decode actual QR output with jsQR, and exercise the file byte-for-byte.

```bash
npm run dev          # terminal 1 — local server on :8787
npm test             # terminal 2 — all four suites against localhost

BASE=https://your-deployment.example.com npm test   # or point them at any live instance
```

## Version

**v1.2.0** (2026-10-09) — clipboard channel: `/c` pairs two devices once and then syncs text and files between them without any claim code (8-character channel code, QR pairing, 20-item / 24-hour room in Workers KV, ~4 s polling, per-item copy button; the existing claim-code and file flows are unchanged).

**v1.1.1** (2026-10-09) — copy-link button: the sender's result card copies the claim URL in one tap (Clipboard API with an `execCommand` fallback and visible button feedback).

**v1.1.0** (2026-10-01) — small-file transfer: the same claim codes now carry files up to 25 MB (drag & drop on `/send`, download page on the receiver side, burn-on-download).

**v1.0.0** (2026-10-01) — first stable release:

- SVG QR generation with styleable modules, colors and error-correction level
- Bridge-by-default codes with a copy / open / share transfer page
- Claim-code transfers (phone ↔ PC, any direction) backed by Workers KV, 32 KB cap, 10-minute TTL, burn-after-read
- Bilingual documentation and a custom-domain-ready deployment

## Typical flows

| I want to… | Do this |
| --- | --- |
| Send text from PC to phone | Paste on homepage to generate claim code, scan QR on phone and tap **Copy all** |
| Send the claim link to someone | Generate on homepage, tap **🔗 复制取件链接** on the result card, paste it into any chat |
| Send text from phone to PC | Open homepage on phone to send, enter the 4-digit claim code on PC below homepage |
| Send a file either way | Drop it on homepage / send page, open claim link on the other device and tap **Download** |
| Move things back and forth all day (same two devices) | Open `/c` once on both and scan the QR — afterwards paste and tap **发送**, the other device picks it up in ~4 s |
| Reuse a clipboard channel in a group | Create the channel, share the `/c/<code>` link or QR — everyone who opens it joins the same room |
| Generate a plain QR code | Enter text on `/qr` for instant SVG rendering and preview |
| Share a Wi-Fi password / contact card | Paste the payload (see formats below), scan — phones parse these natively |

## License

MIT — see the [LICENSE](../LICENSE) at the repository root.
