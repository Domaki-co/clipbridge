import { renderSVG } from 'uqr';

// uqr 0.1.3:renderSVG(data, options) 直接接受字符串并内部编码;
// SVG 相关选项:pixelSize(默认 10)、border(默认 1)、
// blackColor(默认 'black')、whiteColor(默认 'white')、ecc(默认 'L')

interface Env {}

const ECC_LEVELS = ['L', 'M', 'Q', 'H'] as const;

// 复制码:桥接 URL 的字节预算。二维码 V25@纠错M 约可容纳 1591 字节,
// 预算内保证扫得出;超出预算的请求回退为普通文本码。
const BRIDGE_URL_MAX_BYTES = 1500;

const LANDING_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>二维码生成器</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 420px; margin: 3rem auto; padding: 0 1rem; text-align: center; color: #111; }
    input[type="text"] { width: 100%; padding: .6rem; font-size: 1rem; box-sizing: border-box; }
    label { font-size: .85rem; color: #444; }
    #hint { min-height: 1.2em; font-size: .8rem; color: #888; }
    img { margin-top: 1.5rem; max-width: 100%; background: #fff; border: 1px solid #eee; }
    code { display: block; margin-top: .5rem; font-size: .8rem; color: #666; word-break: break-all; }
  </style>
</head>
<body>
  <h1>二维码生成器</h1>
  <p><input id="text" type="text" placeholder="输入网址或文本,回车生成" /></p>
  <p><label><input type="checkbox" id="copymode" /> 复制码(扫码一键复制/打开)</label></p>
  <p id="hint"></p>
  <p><img id="qr" hidden alt="二维码预览" /></p>
  <code id="link"></code>
  <script>
    var input = document.getElementById('text');
    var img = document.getElementById('qr');
    var link = document.getElementById('link');
    var hint = document.getElementById('hint');
    var copymode = document.getElementById('copymode');

    function hintFor(t) {
      if (!t) return '';
      if (copymode.checked) return '复制码:扫码打开中转页,一键复制或打开;内容过长会自动回退为普通码';
      if (t.indexOf('http://') === 0 || t.indexOf('https://') === 0) return '普通码:扫码将直接打开链接';
      return '普通码:扫码将显示文本,长按可复制';
    }

    function refreshHint() { hint.textContent = hintFor(input.value.trim()); }
    input.addEventListener('input', refreshHint);
    copymode.addEventListener('change', refreshHint);

    input.addEventListener('change', function () {
      var t = input.value.trim();
      if (!t) return;
      var u = new URL('/', location);
      u.searchParams.set('text', t);
      if (copymode.checked) u.searchParams.set('mode', 'copy');
      img.src = u.toString();
      img.hidden = false;
      link.textContent = u.toString();
    });
  </script>
</body>
</html>`;

// 复制中转页:数据全部携带在 ?d= 参数里(base64url,z=1 表示 deflate-raw 压缩),
// 服务器不解码、不存储。文本一律用 textContent 注入,杜绝 XSS。
const BRIDGE_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>复制到手机</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 420px; margin: 3rem auto; padding: 0 1rem; text-align: center; color: #111; }
    #content { white-space: pre-wrap; word-break: break-all; text-align: left; background: #f6f6f6; border-radius: 8px; padding: 1rem; font-size: .95rem; max-height: 40vh; overflow: auto; }
    .btn { display: block; margin: 1rem auto 0; padding: .9rem 2rem; font-size: 1.1rem; border-radius: 8px; border: 0; background: #111; color: #fff; text-decoration: none; max-width: 280px; }
    a.btn { background: #4A90D9; }
    footer { margin-top: 2rem; font-size: .75rem; color: #999; }
    #status { color: #666; }
  </style>
</head>
<body>
  <h1>复制到手机</h1>
  <p id="status">解码中…</p>
  <p id="content" hidden></p>
  <button id="copy" class="btn" hidden>复制全文</button>
  <a id="open" class="btn" hidden rel="noopener">打开链接</a>
  <footer>内容随二维码携带,本服务不留存、无统计。</footer>
  <script>
    (function () {
      var status = document.getElementById('status');
      var content = document.getElementById('content');
      var copy = document.getElementById('copy');
      var open = document.getElementById('open');
      var q = new URLSearchParams(location.search);
      var d = q.get('d');

      function bytesFromB64Url(s) {
        s = s.replace(/-/g, '+').replace(/_/g, '/');
        while (s.length % 4) s += '=';
        var bin = atob(s);
        var bytes = new Uint8Array(bin.length);
        for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        return bytes;
      }

      function inflateRaw(bytes) {
        var stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
        return new Response(stream).arrayBuffer().then(function (buf) {
          return new Uint8Array(buf);
        });
      }

      function show(text) {
        status.hidden = true;
        content.textContent = text;
        content.hidden = false;
        copy.hidden = false;
        var t = text.trim().toLowerCase();
        if (t.indexOf('http://') === 0 || t.indexOf('https://') === 0) {
          open.href = text.trim();
          open.hidden = false;
        }
        // 多数浏览器要求用户手势,失败则静默交给按钮
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text).then(function () {
            copy.textContent = '已复制 ✓';
          }, function () {});
        }
      }

      function fail() {
        status.textContent = '内容无效或已损坏';
      }

      copy.addEventListener('click', function () {
        if (!navigator.clipboard || !navigator.clipboard.writeText) {
          copy.textContent = '此浏览器不支持一键复制,请长按选择文本';
          return;
        }
        navigator.clipboard.writeText(content.textContent || '').then(function () {
          copy.textContent = '已复制 ✓';
        }, function () {
          copy.textContent = '复制失败,请长按选择文本';
        });
      });

      try {
        var bytes = bytesFromB64Url(d);
        var p = q.get('z') === '1' ? inflateRaw(bytes) : Promise.resolve(bytes);
        p.then(function (b) { show(new TextDecoder().decode(b)); }, fail);
      } catch (e) {
        fail();
      }
    })();
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

function toBase64Url(bytes: Uint8Array): string {
  let bin = '';
  const CHUNK = 0x8000; // 分段拼接,避免超长数组展开栈溢出
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function deflateRaw(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function bridgeUrl(origin: string, text: string, compressed: Uint8Array | null): string {
  const bytes = compressed ?? new TextEncoder().encode(text);
  return `${origin}/t?d=${toBase64Url(bytes)}${compressed ? '&z=1' : ''}`;
}

// 生成复制码要编码的内容:原文与压缩后的桥接 URL 取更短且在预算内的;
// 都超预算则返回原文,回退为普通文本码(调用方照常出码或按容量报 400)。
async function bridgeContent(origin: string, text: string): Promise<string> {
  const encodeLen = (s: string) => new TextEncoder().encode(s).length;
  const candidates = [bridgeUrl(origin, text, null)];
  try {
    candidates.push(bridgeUrl(origin, text, await deflateRaw(new TextEncoder().encode(text))));
  } catch {
    // 运行时不支持 CompressionStream 时只用原文变体
  }
  const usable = candidates
    .map((u) => ({ u, len: encodeLen(u) }))
    .filter((v) => v.len <= BRIDGE_URL_MAX_BYTES)
    .sort((a, b) => a.len - b.len);
  return usable.length > 0 ? usable[0].u : text;
}

export default {
  async fetch(request, _env, ctx): Promise<Response> {
    const url = new URL(request.url);
    const params = url.searchParams;

    // 复制中转页:扫码侧落地,内容自携带于查询参数
    if (url.pathname === '/t') {
      return new Response(BRIDGE_HTML, {
        headers: {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'public, max-age=86400',
        },
      });
    }

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
      const content =
        (params.get('mode') ?? '').toLowerCase() === 'copy'
          ? await bridgeContent(url.origin, text)
          : text;
      const svg = renderSVG(content, {
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
