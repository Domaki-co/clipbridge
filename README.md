# QR Generator

[English](./README.md) | [简体中文](./README.zh-CN.md)

> Stateless QR-code generator running on Cloudflare Workers — one source file, zero cost, SVG out.
> Deploy it once and get `https://qr-generator.<your-subdomain>.workers.dev`, served from edge nodes worldwide.

## Features

- **SVG output** — crisp at any resolution, returned as `image/svg+xml` with 1-day browser caching
- **Styleable** — module pixel size, quiet-zone margin, foreground/background colors, error-correction level
- **Built-in playground** — visiting the root URL without `?text=` serves a minimal form page
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
├── src/index.ts      # the entire service: parse params → uqr renderSVG → respond
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

## License

MIT — see the [LICENSE](../LICENSE) at the repository root.
