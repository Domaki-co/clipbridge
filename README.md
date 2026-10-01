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
- **Fault-tolerant** — out-of-range numbers are clamped, invalid colors fall back to defaults; bad input never causes a 500
- **CORS-ready** — `Access-Control-Allow-Origin: *`, so the API can be embedded from any origin
- **Stateless & free** — no database, KV or R2; runs comfortably inside the Workers free tier

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
| `/` | GET | Playground page; with `?text=` returns the SVG QR |
| `/t?d=…` | GET | Bridge page where a scanned copy-code lands |
| `/send` | GET | Claim-code sender page |
| `/r` | GET | Claim-code input page (auto-claims at 4 characters) |
| `/r/:code` | GET | Claim a transfer — burn after read |
| `/api/transfer` | POST | Create a transfer, returns `{code, url}` |
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
2. You get a 4-character code (e.g. `K7X2`), a claim URL, and a QR of that URL.
3. On any other device, reach it any of three ways: open `https://qr.example.com/r/K7X2` directly, scan the QR, or open the claim page at `/r` (linked from the homepage) and type `K7X2` — claiming fires automatically once 4 characters are in.

Notes: the code is stored in Workers KV with a 10-minute TTL and is **deleted on first read** (burn after reading), so a leaked or stale code is worthless. The receiver page is the same bridge page served with the payload inlined — no redirect, no URL-length limits. KV free tier allows 1 000 writes/day, far beyond personal use.

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
├── src/index.ts      # the entire service: parse params → uqr renderSVG / bridge page → respond
├── wrangler.jsonc    # Worker configuration
├── package.json
├── tsconfig.json
├── README.md         # this file
└── README.zh-CN.md   # Chinese documentation
```

## Implementation Notes

Small, deliberate deviations from the original implementation doc:

1. `@cloudflare/workers-types` is `^5` — the current wrangler v4 declares it as a peer dependency, and the doc's `^4` fails `npm install`.
2. Text over 2 000 characters returns `400` instead of being silently truncated. The doc asked for both truncation *and* a `400` on 3 000 characters, which contradict each other; the `400` behavior is the safer one for users.

## Version

**v1.0.0** (2026-10-01) — first stable release:

- SVG QR generation with styleable modules, colors and error-correction level
- Bridge-by-default codes with a copy / open / share transfer page
- Claim-code transfers (phone ↔ PC, any direction) backed by Workers KV, 32 KB cap, 10-minute TTL, burn-after-read
- Bilingual documentation and a custom-domain-ready deployment

## License

MIT — see [LICENSE](./LICENSE).
