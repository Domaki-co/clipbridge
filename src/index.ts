import { renderSVG } from 'uqr';

// uqr 0.1.3:renderSVG(data, options) 直接接受字符串并内部编码;
// SVG 相关选项:pixelSize(默认 10)、border(默认 1)、
// blackColor(默认 'black')、whiteColor(默认 'white')、ecc(默认 'L')

interface Env {}

const ECC_LEVELS = ['L', 'M', 'Q', 'H'] as const;

const LANDING_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>二维码生成器</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 420px; margin: 3rem auto; padding: 0 1rem; text-align: center; color: #111; }
    input { width: 100%; padding: .6rem; font-size: 1rem; box-sizing: border-box; }
    img { margin-top: 1.5rem; max-width: 100%; background: #fff; border: 1px solid #eee; }
    code { display: block; margin-top: .5rem; font-size: .8rem; color: #666; word-break: break-all; }
  </style>
</head>
<body>
  <h1>二维码生成器</h1>
  <p><input id="text" placeholder="输入网址或文本,回车生成" /></p>
  <p><img id="qr" hidden alt="二维码预览" /></p>
  <code id="link"></code>
  <script>
    var input = document.getElementById('text');
    var img = document.getElementById('qr');
    var link = document.getElementById('link');
    input.addEventListener('change', function () {
      var t = input.value.trim();
      if (!t) return;
      var u = new URL('/', location);
      u.searchParams.set('text', t);
      img.src = u.toString();
      img.hidden = false;
      link.textContent = u.toString();
    });
  </script>
</body>
</html>`;

function clampInt(v: string | null, min: number, max: number, fallback: number): number {
  if (v === null) return fallback;
  const n = Number.parseInt(v, 10);
  return Number.isNaN(n) ? fallback : Math.min(max, Math.max(min, n));
}

function safeColor(v: string | null, fallback: string): string {
  return v !== null && /^#[0-9a-fA-F]{3,8}$/.test(v) ? v : fallback;
}

function errorJson(message: string, status: number): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

export default {
  async fetch(request, _env, ctx): Promise<Response> {
    const url = new URL(request.url);
    const params = url.searchParams;

    // API 入口:GET /?text=...;无 text 时返回使用页
    if (!params.has('text')) {
      return new Response(LANDING_HTML, {
        headers: { 'content-type': 'text/html; charset=utf-8' },
      });
    }

    const text = (params.get('text') ?? '').trim();
    if (!text) {
      return errorJson('参数 text 不能为空', 400);
    }
    // 静默截断会产出内容缺失的二维码(扫码结果与输入不符),因此超限直接拒绝
    if (text.length > 2000) {
      return errorJson('内容超过 2000 字符上限', 400);
    }

    const eccParam = (params.get('ecl') ?? '').toUpperCase();
    const ecc = (ECC_LEVELS as readonly string[]).includes(eccParam)
      ? (eccParam as (typeof ECC_LEVELS)[number])
      : 'M';

    try {
      const svg = renderSVG(text, {
        ecc,
        pixelSize: clampInt(params.get('size'), 1, 20, 8),
        border: clampInt(params.get('margin'), 0, 10, 2),
        blackColor: safeColor(params.get('color'), '#000000'),
        whiteColor: safeColor(params.get('bg'), '#ffffff'),
      });
      return new Response(svg, {
        headers: {
          'content-type': 'image/svg+xml; charset=utf-8',
          'cache-control': 'public, max-age=86400',
          'access-control-allow-origin': '*',
        },
      });
    } catch {
      return errorJson('内容过长或含无法编码的字符', 400);
    }
  },
} satisfies ExportedHandler;
