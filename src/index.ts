import { renderSVG } from 'uqr';

// uqr 0.1.3:renderSVG(data, options) 直接接受字符串并内部编码;
// SVG 相关选项:pixelSize(默认 10)、border(默认 1)、
// blackColor(默认 'black')、whiteColor(默认 'white')、ecc(默认 'L')

interface Env {
  TRANSFERS: KVNamespace;
  // 剪贴板频道的实时通道:一个频道一个 Durable Object,负责串行化写入并广播给所有连接。
  // 可缺失(未配置 DO 绑定时功能退化为纯 KV + 轮询,一切照旧)。
  CHANNELS?: DurableObjectNamespace;
}

const ECC_LEVELS = ['L', 'M', 'Q', 'H'] as const;

// 站点图标:深色圆角底 + 三个二维码定位角 + 蓝色数据点,矢量单文件
const FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <rect width="64" height="64" rx="14" fill="#15181d"/>
  <rect x="9" y="9" width="20" height="20" rx="5" fill="#ffffff"/>
  <rect x="14" y="14" width="10" height="10" rx="2.5" fill="#15181d"/>
  <rect x="35" y="9" width="20" height="20" rx="5" fill="#ffffff"/>
  <rect x="40" y="14" width="10" height="10" rx="2.5" fill="#15181d"/>
  <rect x="9" y="35" width="20" height="20" rx="5" fill="#ffffff"/>
  <rect x="14" y="40" width="10" height="10" rx="2.5" fill="#15181d"/>
  <rect x="35" y="35" width="9" height="9" rx="2" fill="#4a90d9"/>
  <rect x="46" y="35" width="9" height="9" rx="2" fill="#ffffff"/>
  <rect x="35" y="46" width="9" height="9" rx="2" fill="#ffffff"/>
  <rect x="46" y="46" width="9" height="9" rx="2" fill="#4a90d9"/>
</svg>`;

// 复制码:桥接 URL 的字节预算。二维码 V25@纠错M 约可容纳 1591 字节,
// 预算内保证扫得出;超出预算的请求回退为普通文本码。
const BRIDGE_URL_MAX_BYTES = 1500;

// 取件码互传:KV 存 10 分钟自动过期,取件即焚,文本上限 32KB,文件上限 25MB
const TRANSFER_TTL_SECONDS = 600;
const TRANSFER_MAX_BYTES = 32768;
const MAX_FILE_BYTES = 25 * 1000 * 1000; // KV 单值硬顶 25MiB,留出安全余量
// 无歧义字符表:去掉 I/L/O/0/1,避免手抄混淆
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

// 剪贴板频道(常驻):配对一次后两端免输码,内容保留 24 小时、每次写入续期。
// 与一次性取件码完全并行的链路:独立键前缀 c:,不触碰 t: 的焚毁语义。
const CHANNEL_TTL_SECONDS = 86400;
const CHANNEL_CODE_LENGTH = 8;
// 频道码是长期凭证(不会用一次就换),所以位数多于 4 位取件码
const CHANNEL_CODE_RE = /^[A-HJKMNP-Z2-9]{8}$/;
const CHANNEL_MAX_ITEMS = 20; // 索引只保留最近 20 条,更早的正文随 TTL 自行过期
const CHANNEL_PREVIEW_CHARS = 120; // 索引里只放预览,正文/文件各存独立键
const CHANNEL_PREFIX = 'c:';
const CHANNEL_PAYLOAD_SEP = ':e:';

const QR_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>文桥 ClipBridge · 二维码生成</title>
  <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
  <style>
    [hidden] { display: none !important; }
    body { font-family: system-ui, -apple-system, "PingFang SC", "Segoe UI", sans-serif; margin: 0; padding: 2.5rem 1rem 3rem; color: #171a20; text-align: center; background-color: #f4f6fa; background-image: radial-gradient(720px 320px at 50% -60px, rgba(74,144,217,.16), rgba(74,144,217,0)); min-height: 100vh; -webkit-font-smoothing: antialiased; }
    .card { max-width: 430px; margin: 0 auto; background: #fff; border: 1px solid #e9edf4; border-radius: 20px; padding: 1.4rem 1.3rem 1.2rem; box-shadow: 0 12px 40px rgba(23,26,32,.07); }
    .top { display: flex; align-items: center; justify-content: space-between; margin-bottom: 1rem; }
    .brand { display: flex; align-items: center; gap: .45rem; font-size: .9rem; font-weight: 600; color: #171a20; text-decoration: none; }
    .brand img { width: 20px; height: 20px; border-radius: 5px; display: block; }
    .home { font-size: .82rem; color: #667085; text-decoration: none; padding: .32rem .75rem; border-radius: 999px; background: #f1f4f9; }
    .home:hover { background: #e7ecf4; color: #171a20; }
    .title { font-size: 1.25rem; margin: .4rem 0 .2rem; }
    p { margin: .6rem 0 0; }
    input[type="text"] { width: 100%; padding: .85rem 1rem; font-size: 1rem; box-sizing: border-box; border: 1px solid #dfe5ee; border-radius: 12px; background: #f8fafd; }
    input[type="text"]:focus { outline: none; border-color: #4a90d9; background: #fff; box-shadow: 0 0 0 3px rgba(74,144,217,.15); }
    #hint { min-height: 1.2em; margin: .55rem 0 0; font-size: .8rem; color: #8a93a3; }
    #qr { margin-top: 1.1rem; width: 240px; max-width: 100%; background: #fff; border: 1px solid #eef1f6; border-radius: 14px; padding: 10px; box-sizing: border-box; box-shadow: 0 8px 24px rgba(23,26,32,.08); }
    code { display: block; margin-top: .7rem; font-size: .78rem; color: #667085; word-break: break-all; }
    .nav { margin: 1rem 0 0; }
    .nav a { font-size: .82rem; color: #98a1b0; text-decoration: none; }
    .nav a:hover { color: #171a20; }
  </style>
</head>
<body>
  <main class="card">
    <div class="top">
      <a class="brand" href="/"><img src="/favicon.svg" alt="" />文桥 ClipBridge</a>
      <a class="home" href="/">← 首页</a>
    </div>
    <h1 class="title">文本,一扫即传</h1>
    <p><input id="text" type="text" placeholder="输入网址或文本,回车生成" /></p>
    <p id="hint"></p>
    <p><img id="qr" hidden alt="二维码预览" /></p>
    <code id="link"></code>
  </main>
  <p class="nav"><a href="/">← 返回传输首页</a> · <a href="/r">取件码取件</a></p>
  <script>
    var input = document.getElementById('text');
    var img = document.getElementById('qr');
    var link = document.getElementById('link');
    var hint = document.getElementById('hint');

    function hintFor(t) {
      return t ? '扫码后可选择:复制全文 / 打开链接 / 分享' : '';
    }

    input.addEventListener('input', function () {
      hint.textContent = hintFor(input.value.trim());
    });

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

// 首页:分段选项卡 (Tab 1: 文本/文件发送; Tab 2: 4位取件码取件)
const LANDING_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>文桥 ClipBridge · 文本同步</title>
  <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
  <style>
    [hidden] { display: none !important; }
    * { box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
      margin: 0;
      padding: 2.2rem 1rem 3rem;
      color: #0f172a;
      text-align: center;
      background-color: #f6f8fc;
      background-image:
        radial-gradient(800px 380px at 50% -80px, rgba(59, 130, 246, 0.15), rgba(59, 130, 246, 0)),
        radial-gradient(600px 300px at 50% 100%, rgba(203, 213, 225, 0.2), rgba(203, 213, 225, 0));
      min-height: 100vh;
      -webkit-font-smoothing: antialiased;
      -webkit-tap-highlight-color: transparent;
    }
    .card {
      max-width: 440px;
      margin: 0 auto;
      background: #ffffff;
      border: 1px solid rgba(226, 232, 240, 0.9);
      border-radius: 24px;
      padding: 1.5rem 1.4rem 1.4rem;
      box-shadow: 0 16px 40px -4px rgba(15, 23, 42, 0.07), 0 4px 12px -2px rgba(15, 23, 42, 0.02);
      transition: box-shadow 0.2s ease;
    }
    .top {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 1.15rem;
    }
    .brand {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      font-size: 0.95rem;
      font-weight: 700;
      color: #0f172a;
      text-decoration: none;
      letter-spacing: -0.01em;
    }
    .brand img {
      width: 22px;
      height: 22px;
      border-radius: 6px;
      display: block;
    }
    .badge {
      font-size: 0.73rem;
      color: #64748b;
      background: #f1f5f9;
      padding: 0.25rem 0.65rem;
      border-radius: 999px;
      font-weight: 500;
      letter-spacing: 0.02em;
    }
    .tabs {
      display: flex;
      background: #f1f5f9;
      padding: 4px;
      border-radius: 14px;
      margin-bottom: 1.25rem;
      gap: 4px;
    }
    .tab-btn {
      flex: 1;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      padding: 0.65rem 0;
      font-size: 0.93rem;
      font-weight: 600;
      color: #64748b;
      border: 0;
      border-radius: 10px;
      background: transparent;
      cursor: pointer;
      transition: all 0.16s cubic-bezier(0.4, 0, 0.2, 1);
    }
    .tab-btn:hover {
      color: #1e293b;
    }
    .tab-btn.active {
      background: #ffffff;
      color: #0f172a;
      box-shadow: 0 2px 8px rgba(15, 23, 42, 0.08), 0 1px 2px rgba(15, 23, 42, 0.04);
    }
    .tab-icon {
      font-size: 1rem;
      line-height: 1;
    }
    textarea {
      width: 100%;
      min-height: 8.5rem;
      padding: 0.85rem 1rem;
      font-size: 0.98rem;
      font-family: inherit;
      border: 1px solid #e2e8f0;
      border-radius: 14px;
      background: #f8fafc;
      color: #0f172a;
      resize: vertical;
      line-height: 1.5;
      transition: border-color 0.15s, box-shadow 0.15s, background 0.15s;
    }
    textarea:focus {
      outline: none;
      border-color: #3b82f6;
      background: #ffffff;
      box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.15);
    }
    .filebox {
      margin-top: 0.75rem;
    }
    .pickbtn {
      width: 100%;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 0.5rem;
      padding: 0.72rem 1rem;
      font-size: 0.88rem;
      font-weight: 500;
      border-radius: 12px;
      border: 1.5px dashed #cbd5e1;
      background: #f8fafc;
      color: #475569;
      cursor: pointer;
      transition: all 0.15s ease;
    }
    .pickbtn:hover, .pickbtn.dragover {
      border-color: #3b82f6;
      background: #eff6ff;
      color: #1d4ed8;
    }
    .pick-limit {
      font-size: 0.78rem;
      color: #94a3b8;
    }
    .chip {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      width: 100%;
      padding: 0.6rem 0.9rem;
      background: #f0f7ff;
      border: 1px solid #bfdbfe;
      border-radius: 12px;
      font-size: 0.88rem;
      color: #1e40af;
    }
    .chipname {
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      text-align: left;
      font-weight: 500;
    }
    .chip button {
      border: 0;
      background: rgba(30, 64, 175, 0.1);
      width: 22px;
      height: 22px;
      border-radius: 50%;
      cursor: pointer;
      color: #1e40af;
      font-size: 0.75rem;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 0;
      transition: background 0.15s;
    }
    .chip button:hover {
      background: rgba(30, 64, 175, 0.2);
    }
    .btn {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 0.4rem;
      width: 100%;
      margin-top: 0.9rem;
      padding: 0.9rem 0;
      font-size: 1rem;
      font-weight: 600;
      border-radius: 14px;
      border: 0;
      background: linear-gradient(180deg, #1e293b, #0f172a);
      color: #ffffff;
      cursor: pointer;
      transition: transform 0.08s ease, filter 0.15s ease, box-shadow 0.15s ease;
      box-shadow: 0 4px 14px rgba(15, 23, 42, 0.18);
    }
    .btn:active {
      transform: scale(0.985);
    }
    .btn:hover {
      filter: brightness(1.15);
      box-shadow: 0 6px 18px rgba(15, 23, 42, 0.25);
    }
    .btn:disabled {
      opacity: 0.55;
      cursor: not-allowed;
    }
    .btn.secondary {
      margin-top: 0.6rem;
      background: #ffffff;
      color: #1d4ed8;
      border: 1.5px solid #bfdbfe;
      box-shadow: 0 2px 10px rgba(37, 99, 235, 0.08);
    }
    .btn.secondary:hover {
      background: #eff6ff;
      filter: none;
      box-shadow: 0 4px 14px rgba(37, 99, 235, 0.16);
    }
    .copy-pill.copied,
    .btn.secondary.copied {
      color: #047857;
      background: #ecfdf5;
      border-color: #a7f3d0;
    }
    #msg {
      min-height: 1.3em;
      margin: 0.5rem 0 0;
      font-size: 0.85rem;
      color: #ef4444;
    }
    #progress {
      min-height: 1.2em;
      margin: 0.4rem 0 0;
      font-size: 0.82rem;
      color: #64748b;
    }
    .result-card {
      margin-top: 1.2rem;
      background: #f8fafc;
      border: 1px solid #e2e8f0;
      border-radius: 16px;
      padding: 1.1rem 1rem;
      text-align: center;
    }
    .result-step {
      font-size: 0.85rem;
      color: #475569;
      font-weight: 500;
      margin: 0 0 0.6rem;
    }
    .code-box {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 0.6rem;
      background: #ffffff;
      border: 1.5px dashed #93c5fd;
      border-radius: 12px;
      padding: 0.45rem 1.1rem;
      margin-bottom: 0.6rem;
    }
    #code {
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      font-size: 1.8rem;
      letter-spacing: 0.25em;
      margin-right: -0.25em;
      font-weight: 800;
      color: #0f172a;
    }
    .copy-pill {
      font-size: 0.75rem;
      font-weight: 600;
      color: #2563eb;
      background: #eff6ff;
      border: 1px solid #bfdbfe;
      border-radius: 999px;
      padding: 0.2rem 0.55rem;
      cursor: pointer;
      transition: all 0.15s;
    }
    .copy-pill:hover {
      background: #dbeafe;
    }
    #qr {
      margin: 0.4rem 0;
      width: 210px;
      max-width: 100%;
      background: #ffffff;
      border: 1px solid #e2e8f0;
      border-radius: 14px;
      padding: 8px;
      box-shadow: 0 4px 16px rgba(15, 23, 42, 0.06);
    }
    a.claim {
      display: inline-block;
      margin: 0.2rem 0;
      font-size: 0.88rem;
      color: #2563eb;
      word-break: break-all;
      text-decoration: none;
    }
    a.claim:hover {
      text-decoration: underline;
    }
    .note {
      font-size: 0.78rem;
      color: #94a3b8;
      margin: 0.7rem 0 0;
      line-height: 1.45;
    }
    .devwarn {
      margin: 0 0 0.9rem;
      padding: 0.6rem 0.8rem;
      background: #fffbeb;
      border: 1px solid #fde68a;
      border-radius: 12px;
      font-size: 0.78rem;
      color: #92400e;
      text-align: left;
      line-height: 1.5;
    }
    .claim-hero {
      text-align: center;
      padding: 0.6rem 0 0.2rem;
    }
    .claim-icon-large {
      font-size: 2.2rem;
      line-height: 1;
      margin-bottom: 0.4rem;
    }
    .claim-title {
      font-size: 1.15rem;
      font-weight: 700;
      color: #0f172a;
      margin: 0 0 0.3rem;
    }
    .claim-desc {
      font-size: 0.82rem;
      color: #64748b;
      margin: 0;
    }
    .code-input-wrap {
      margin: 1.1rem auto 0.4rem;
      max-width: 250px;
    }
    #claimcode {
      width: 100%;
      padding: 0.85rem 0.5rem;
      font-size: 1.7rem;
      font-weight: 800;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      letter-spacing: 0.3em;
      text-indent: 0.3em;
      text-transform: uppercase;
      text-align: center;
      border: 2px solid #cbd5e1;
      border-radius: 16px;
      background: #f8fafc;
      color: #0f172a;
      transition: all 0.15s ease;
    }
    #claimcode:focus {
      outline: none;
      border-color: #3b82f6;
      background: #ffffff;
      box-shadow: 0 0 0 4px rgba(59, 130, 246, 0.15);
    }
    #claimcode::placeholder {
      color: #cbd5e1;
      font-weight: 500;
      letter-spacing: 0.15em;
      text-indent: 0.15em;
    }
    #claimmsg {
      min-height: 1.3em;
      margin: 0.4rem 0 0;
      font-size: 0.85rem;
      color: #ef4444;
    }
    .nav {
      margin: 1.25rem 0 0;
    }
    .nav a {
      font-size: 0.82rem;
      color: #94a3b8;
      text-decoration: none;
      transition: color 0.15s;
    }
    .nav a:hover {
      color: #1e293b;
    }
  </style>
</head>
<body>
  <main class="card">
    <div class="top">
      <a class="brand" href="/"><img src="/favicon.svg" alt="" />文桥 ClipBridge</a>
      <span class="badge">免登录 · 阅后即焚</span>
    </div>
    <p id="devwarn" class="devwarn" hidden>⚠️ 本地开发环境:取件数据只存在本机,而取件链接指向线上域名——手机扫码会取不到。完整流程请在线上域名下测试。</p>
    
    <div class="tabs" role="tablist">
      <button class="tab-btn active" id="tab-send" type="button" role="tab" aria-selected="true">
        <span class="tab-icon">📨</span> 我要发送
      </button>
      <button class="tab-btn" id="tab-claim" type="button" role="tab" aria-selected="false">
        <span class="tab-icon">📥</span> 快速取件
      </button>
    </div>

    <!-- 面板 1: 发送 -->
    <div id="panel-send">
      <p><textarea id="text" placeholder="粘贴要传输的文本,生成取件码或二维码..."></textarea></p>
      <div class="filebox" id="filebox">
        <input type="file" id="file" hidden />
        <button id="pick" class="pickbtn" type="button">
          <span>📎 点击或拖入文件</span>
          <span class="pick-limit">(≤ 25MB)</span>
        </button>
        <div id="chip" class="chip" hidden>
          <span style="font-size:1.1rem;line-height:1">📄</span>
          <span id="chipname" class="chipname"></span>
          <button id="chipx" type="button" aria-label="移除文件">✕</button>
        </div>
      </div>
      <p><button id="go" class="btn" type="button">生成取件码</button></p>
      <p id="progress"></p>
      <p id="msg"></p>
      <div id="result" class="result-card" hidden>
        <p class="result-step">在另一台设备打开取件链接、扫码或输入码:</p>
        <div class="code-box">
          <span id="code"></span>
          <button id="copy-code-btn" class="copy-pill" type="button" data-label="复制" data-fail="请长按">复制</button>
        </div>
        <p><img id="qr" alt="取件二维码" /></p>
        <p><a id="claimurl" class="claim" target="_blank" rel="noopener"></a></p>
        <p><button id="copy-url-btn" class="btn secondary" type="button" data-label="🔗 复制取件链接" data-fail="复制失败,请长按链接手动复制">🔗 复制取件链接</button></p>
        <p class="note">取件码 10 分钟内有效;文本取件即焚,文件到期自动销毁。</p>
      </div>
    </div>

    <!-- 面板 2: 取件 -->
    <div id="panel-claim" hidden>
      <div class="claim-hero">
        <div class="claim-icon-large">📥</div>
        <h2 class="claim-title">输入 4 位取件码</h2>
        <p class="claim-desc">在接收设备输入发送方提供的 4 位代码</p>
      </div>
      <div class="code-input-wrap">
        <input id="claimcode" placeholder="如 K7X2" maxlength="4" autocomplete="off" />
      </div>
      <p id="claimmsg"></p>
      <p><button id="claimgo" class="btn" type="button">立即取件</button></p>
      <p class="note">取件码 10 分钟内有效;文本阅后即焚(仅可提取一次)。</p>
    </div>
  </main>

  <p class="nav"><a href="/qr">普通二维码生成</a> · <a href="/r">独立取件页</a> · <a href="/send">发送页</a> · <a href="/c">剪贴板频道</a></p>

  <script>
    if (location.hostname === 'localhost' || location.hostname === '127.0.0.1') {
      document.getElementById('devwarn').hidden = false;
    }

    var tabSend = document.getElementById('tab-send');
    var tabClaim = document.getElementById('tab-claim');
    var panelSend = document.getElementById('panel-send');
    var panelClaim = document.getElementById('panel-claim');

    var text = document.getElementById('text');
    var go = document.getElementById('go');
    var msg = document.getElementById('msg');
    var progress = document.getElementById('progress');
    var result = document.getElementById('result');
    var claimurl = document.getElementById('claimurl');
    var code = document.getElementById('code');
    var copyCodeBtn = document.getElementById('copy-code-btn');
    var copyUrlBtn = document.getElementById('copy-url-btn');
    var qr = document.getElementById('qr');
    var fileInput = document.getElementById('file');
    var pick = document.getElementById('pick');
    var chip = document.getElementById('chip');
    var chipname = document.getElementById('chipname');
    var filebox = document.getElementById('filebox');
    var currentFile = null;

    var claimCode = document.getElementById('claimcode');
    var claimGo = document.getElementById('claimgo');
    var claimMsg = document.getElementById('claimmsg');

    function switchTab(toClaim) {
      if (toClaim) {
        tabSend.classList.remove('active');
        tabSend.setAttribute('aria-selected', 'false');
        tabClaim.classList.add('active');
        tabClaim.setAttribute('aria-selected', 'true');
        panelSend.hidden = true;
        panelClaim.hidden = false;
        claimCode.focus();
      } else {
        tabClaim.classList.remove('active');
        tabClaim.setAttribute('aria-selected', 'false');
        tabSend.classList.add('active');
        tabSend.setAttribute('aria-selected', 'true');
        panelClaim.hidden = true;
        panelSend.hidden = false;
      }
    }

    tabSend.addEventListener('click', function () { switchTab(false); });
    tabClaim.addEventListener('click', function () { switchTab(true); });

    if (location.hash === '#claim' || new URLSearchParams(location.search).get('tab') === 'claim') {
      switchTab(true);
    }

    function fmtSize(n) {
      if (n >= 1000 * 1000) return (n / 1000 / 1000).toFixed(1) + ' MB';
      if (n >= 1000) return (n / 1000).toFixed(1) + ' KB';
      return n + ' B';
    }

    function setFile(f) {
      currentFile = f || null;
      if (currentFile) {
        chipname.textContent = currentFile.name + ' · ' + fmtSize(currentFile.size);
        chip.hidden = false;
        pick.hidden = true;
      } else {
        fileInput.value = '';
        chip.hidden = true;
        pick.hidden = false;
      }
    }

    pick.addEventListener('click', function () { fileInput.click(); });
    fileInput.addEventListener('change', function () { setFile(fileInput.files[0]); });
    document.getElementById('chipx').addEventListener('click', function () { setFile(null); });

    document.addEventListener('dragover', function (e) { e.preventDefault(); });
    document.addEventListener('drop', function (e) { e.preventDefault(); });
    filebox.addEventListener('dragover', function (e) { e.preventDefault(); pick.classList.add('dragover'); });
    filebox.addEventListener('dragleave', function () { pick.classList.remove('dragover'); });
    filebox.addEventListener('drop', function (e) {
      e.preventDefault();
      pick.classList.remove('dragover');
      if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]) setFile(e.dataTransfer.files[0]);
    });

    var currentRawCode = '';
    var currentClaimUrl = '';
    function showResult(j) {
      msg.textContent = '';
      progress.textContent = '';
      currentRawCode = j.code;
      currentClaimUrl = j.url;
      code.textContent = j.code.split('').join(' ');
      claimurl.textContent = j.url;
      claimurl.href = j.url;
      qr.src = '/?text=' + encodeURIComponent(j.url) + '&mode=text';
      result.hidden = false;
    }

    // 非安全上下文(如用 IP 访问)没有 Clipboard API,退回 execCommand 兜底
    function fallbackCopy(t) {
      try {
        var ta = document.createElement('textarea');
        ta.value = t;
        ta.setAttribute('readonly', '');
        ta.style.position = 'fixed';
        ta.style.top = '-1000px';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        ta.setSelectionRange(0, t.length);
        var ok = document.execCommand('copy');
        document.body.removeChild(ta);
        return ok;
      } catch (e) {
        return false;
      }
    }

    // 复制并给出按钮级反馈:成功显示「已复制 ✓」,1.6 秒后复原;失败提示手动长按复制
    function copyText(btn, value) {
      var label = btn.getAttribute('data-label') || btn.textContent;
      function finish(ok) {
        btn.textContent = ok ? '已复制 ✓' : (btn.getAttribute('data-fail') || '复制失败,请长按选择');
        btn.classList.toggle('copied', !!ok);
        clearTimeout(btn._copyTimer);
        btn._copyTimer = setTimeout(function () {
          btn.textContent = label;
          btn.classList.remove('copied');
        }, 1600);
      }
      var write = navigator.clipboard && navigator.clipboard.writeText
        ? navigator.clipboard.writeText(value)
        : Promise.reject();
      Promise.resolve(write).then(function () { finish(true); }, function () {
        finish(fallbackCopy(value));
      });
    }

    copyCodeBtn.addEventListener('click', function () {
      if (currentRawCode) copyText(copyCodeBtn, currentRawCode);
    });

    // 取件链接一键复制:发给别人时不必先打开(打开即取件,文本会被烧掉)
    copyUrlBtn.addEventListener('click', function () {
      if (currentClaimUrl) copyText(copyUrlBtn, currentClaimUrl);
    });

    function uploadFile() {
      var f = currentFile;
      if (f.size > 25 * 1000 * 1000) { msg.textContent = '文件超过 25MB 上限'; return; }
      go.disabled = true;
      msg.textContent = '';
      progress.textContent = '上传中 0%';
      var xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/transfer');
      xhr.setRequestHeader('content-type', f.type || 'application/octet-stream');
      try { xhr.setRequestHeader('x-file-name', encodeURIComponent(f.name)); } catch (e) {}
      xhr.upload.onprogress = function (e) {
        if (e.lengthComputable) progress.textContent = '上传中 ' + Math.round((e.loaded / e.total) * 100) + '%';
      };
      xhr.onload = function () {
        go.disabled = false;
        progress.textContent = '';
        var j = {};
        try { j = JSON.parse(xhr.responseText); } catch (e) {}
        if (xhr.status === 200) { showResult(j); }
        else { msg.textContent = j.error || '上传失败,请重试'; }
      };
      xhr.onerror = function () {
        go.disabled = false;
        progress.textContent = '';
        msg.textContent = '网络错误,请重试';
      };
      xhr.send(f);
    }

    function doSend() {
      if (currentFile) { uploadFile(); return; }
      var t = text.value.trim();
      if (!t) { msg.textContent = '请先输入内容或选择文件'; return; }
      if (new TextEncoder().encode(t).length > 32768) { msg.textContent = '内容超过 32KB 上限'; return; }
      go.disabled = true;
      msg.textContent = '生成中…';
      fetch('/api/transfer', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: t })
      }).then(function (r) {
        return r.json().then(function (j) { return { ok: r.ok, j: j }; });
      }).then(function (res) {
        go.disabled = false;
        if (!res.ok) { msg.textContent = res.j.error || '生成失败,请重试'; return; }
        showResult(res.j);
      }, function () {
        go.disabled = false;
        msg.textContent = '网络错误,请重试';
      });
    }

    go.addEventListener('click', doSend);
    text.addEventListener('keydown', function (e) {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') doSend();
    });

    function doClaim() {
      var c = claimCode.value.trim().toUpperCase();
      if (!c) { claimMsg.textContent = '请输入取件码'; return; }
      if (!/^[A-HJKMNP-Z2-9]{4}$/.test(c)) {
        claimMsg.textContent = '取件码为 4 位,且不含 I/L/O/0/1';
        return;
      }
      location.href = '/r/' + c;
    }

    claimCode.addEventListener('input', function () {
      claimCode.value = claimCode.value.toUpperCase().replace(/[^A-HJKMNP-Z2-9]/g, '');
      claimMsg.textContent = '';
      if (claimCode.value.length === 4) doClaim();
    });
    claimCode.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') doClaim();
    });
    claimGo.addEventListener('click', doClaim);
  </script>
</body>
</html>`;

// 复制中转页:数据全部携带在 ?d= 参数里(base64url,z=1 表示 deflate-raw 压缩),
// 服务器不解码、不存储。文本一律用 textContent 注入,杜绝 XSS。
// 交互:扫码后立即给出三选一 —— 复制全文 / 打开链接(仅 URL) / 分享到其他应用
// (系统分享面板,即"粘贴进 App")。剪贴板只在点击「复制全文」时写入,不做隐式复制。
// 缓存只给 5 分钟:页面交互迭代频繁,避免手机浏览器长时间滞留旧版。
// 中转页模板:__PAYLOAD__ 由 bridgeHtml() 注入——/t 传 null(读 URL 参数),
// /r/:code 传 {d,z}(服务端内联,避免重定向与 URL 长度限制)。
// replace 用函数形式,防止载荷内容被当作替换模式解释。
function bridgeHtml(payload: { d: string; z: number } | null): string {
  return BRIDGE_HTML_TEMPLATE.replace('__PAYLOAD__', () => JSON.stringify(payload));
}

const BRIDGE_HTML_TEMPLATE = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>复制到手机</title>
  <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
  <style>
    [hidden] { display: none !important; }
    body { font-family: system-ui, -apple-system, "PingFang SC", "Segoe UI", sans-serif; margin: 0; padding: 2.5rem 1rem 3rem; color: #171a20; text-align: center; background-color: #f4f6fa; background-image: radial-gradient(720px 320px at 50% -60px, rgba(74,144,217,.16), rgba(74,144,217,0)); min-height: 100vh; -webkit-font-smoothing: antialiased; -webkit-tap-highlight-color: rgba(0,0,0,.06); }
    .card { max-width: 430px; margin: 0 auto; background: #fff; border: 1px solid #e9edf4; border-radius: 20px; padding: 1.4rem 1.3rem 1.2rem; box-shadow: 0 12px 40px rgba(23,26,32,.07); }
    .top { display: flex; align-items: center; justify-content: space-between; margin-bottom: 1rem; }
    .brand { display: flex; align-items: center; gap: .45rem; font-size: .9rem; font-weight: 600; color: #171a20; text-decoration: none; }
    .brand img { width: 20px; height: 20px; border-radius: 5px; display: block; }
    .home { font-size: .82rem; color: #667085; text-decoration: none; padding: .32rem .75rem; border-radius: 999px; background: #f1f4f9; }
    .home:hover { background: #e7ecf4; color: #171a20; }
    p { margin: .45rem 0 0; }
    .status { display: inline-block; padding: .32rem .95rem; border-radius: 999px; background: #f1f4f9; color: #667085; font-size: .82rem; }
    .status.ok { background: #e6f6ee; color: #147a4d; }
    .status.err { background: #fdeeee; color: #b03a2e; }
    .content { text-align: left; white-space: pre-wrap; word-break: break-all; background: #f7f9fc; border: 1px solid #eef1f6; border-radius: 12px; padding: 1rem 1.1rem; font-size: .98rem; line-height: 1.55; max-height: 32vh; overflow: auto; }
    .actions { display: flex; flex-direction: column; gap: .6rem; margin-top: 1.1rem; }
    .btn { display: flex; align-items: center; justify-content: center; gap: .45rem; width: 100%; padding: .95rem 0; font-size: 1.02rem; font-weight: 600; border-radius: 12px; border: 0; cursor: pointer; text-decoration: none; transition: transform .06s ease, filter .15s ease; }
    .btn:active { transform: scale(.985); }
    .btn.primary { background: linear-gradient(180deg, #23272f, #15181d); color: #fff; box-shadow: 0 6px 16px rgba(21,24,29,.22); }
    .btn.primary:hover { filter: brightness(1.15); }
    a.btn.blue { background: linear-gradient(180deg, #57a0f5, #3d7ef0); color: #fff; box-shadow: 0 6px 16px rgba(61,126,240,.28); }
    a.btn.blue:hover { filter: brightness(1.06); }
    .btn.plain { background: #fff; border: 1px solid #dfe5ee; color: #333; }
    .btn.plain:hover { background: #f6f8fc; }
    .note { margin: 1.2rem 0 0; font-size: .75rem; color: #98a1b0; }
  </style>
</head>
<body>
  <main class="card">
    <div class="top">
      <a class="brand" href="/"><img src="/favicon.svg" alt="" />文桥 ClipBridge</a>
      <a class="home" href="/">← 首页</a>
    </div>
    <p><span id="status" class="status">解码中…</span></p>
    <div id="body" hidden>
      <div id="content" class="content"></div>
      <div class="actions">
        <button id="copy" class="btn primary" type="button">📋 复制全文</button>
        <a id="open" class="btn blue" hidden rel="noopener">🔗 打开链接</a>
        <button id="share" class="btn plain" type="button" hidden>📤 分享 / 粘贴到其他应用</button>
      </div>
    </div>
    <footer class="note">内容随二维码携带,本服务不留存、无统计。</footer>
  </main>
  <script>
    (function () {
      var status = document.getElementById('status');
      var body = document.getElementById('body');
      var content = document.getElementById('content');
      var copy = document.getElementById('copy');
      var open = document.getElementById('open');
      var share = document.getElementById('share');
      var q = new URLSearchParams(location.search);
      // /t 由 URL 查询参数携带(PAYLOAD 为 null),/r/:code 由服务端内联
      var init = __PAYLOAD__;
      var d = init ? init.d : q.get('d');
      var compressed = init ? init.z === 1 : q.get('z') === '1';
      var current = '';

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

      var HINT = '选择下方操作';

      function setStatus(text, cls) {
        status.textContent = text;
        status.className = 'status' + (cls ? ' ' + cls : '');
      }

      function copyThen() {
        if (!navigator.clipboard || !navigator.clipboard.writeText) {
          setStatus('此浏览器不支持一键复制,请长按选择文本', 'err');
          return;
        }
        navigator.clipboard.writeText(current).then(function () {
          setStatus('已复制 ✓', 'ok');
        }, function () {
          setStatus('复制失败,请长按选择文本', 'err');
        });
      }

      // 只有点击「复制全文」才写入剪贴板,不做任何隐式复制
      copy.addEventListener('click', function () {
        copyThen(null, false);
      });
      share.addEventListener('click', function (e) {
        e.stopPropagation();
        var payload = { text: current };
        // 分享面板调不起来(部分 WebView 有 API 无实现)时,自动降级为复制
        function fallback() {
          copyThen();
        }
        if (navigator.canShare && !navigator.canShare(payload)) {
          setStatus('此环境不支持分享,已为你复制');
          copyThen();
          return;
        }
        setStatus('调起分享面板…');
        try {
          navigator.share(payload).then(function () {
            setStatus('已分享 ✓', 'ok');
          }, function (err) {
            if (err && err.name === 'AbortError') { // 用户关闭面板,不算错误
              setStatus(HINT);
              return;
            }
            fallback();
          });
        } catch (err) {
          fallback();
        }
      });

      function show(text) {
        current = text;
        content.textContent = text;
        var t = text.trim().toLowerCase();
        if (t.indexOf('http://') === 0 || t.indexOf('https://') === 0) {
          open.href = text.trim();
          open.hidden = false;
        }
        if (navigator.share) share.hidden = false;
        setStatus(HINT);
        body.hidden = false;
      }

      function fail() {
        setStatus('内容无效或已损坏', 'err');
      }

      try {
        var bytes = bytesFromB64Url(d);
        var p = compressed ? inflateRaw(bytes) : Promise.resolve(bytes);
        p.then(function (b) { show(new TextDecoder().decode(b)); }, fail);
      } catch (e) {
        fail();
      }
    })();
  </script>
</body>
</html>`;

// 取件码发送页:与首页共用传输与取件界面
const SEND_HTML = LANDING_HTML;

// 文件取件页:展示文件名/大小,下载按钮指向 /r/:code/download(下载即焚)。
// __META__ 注入 {name,size,url},文件名一律 textContent 渲染,防 XSS。
function fileClaimPage(meta: { name: string; size: number; url: string }): string {
  return FILE_CLAIM_HTML_TEMPLATE.replace('__META__', () => JSON.stringify(meta));
}

const FILE_CLAIM_HTML_TEMPLATE = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>文件取件</title>
  <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
  <style>
    [hidden] { display: none !important; }
    body { font-family: system-ui, -apple-system, "PingFang SC", "Segoe UI", sans-serif; margin: 0; padding: 2.5rem 1rem 3rem; color: #171a20; text-align: center; background-color: #f4f6fa; background-image: radial-gradient(720px 320px at 50% -60px, rgba(74,144,217,.16), rgba(74,144,217,0)); min-height: 100vh; -webkit-font-smoothing: antialiased; }
    .card { max-width: 430px; margin: 0 auto; background: #fff; border: 1px solid #e9edf4; border-radius: 20px; padding: 1.4rem 1.3rem 1.2rem; box-shadow: 0 12px 40px rgba(23,26,32,.07); }
    .top { display: flex; align-items: center; justify-content: space-between; margin-bottom: 1rem; }
    .brand { display: flex; align-items: center; gap: .45rem; font-size: .9rem; font-weight: 600; color: #171a20; text-decoration: none; }
    .brand img { width: 20px; height: 20px; border-radius: 5px; display: block; }
    .home { font-size: .82rem; color: #667085; text-decoration: none; padding: .32rem .75rem; border-radius: 999px; background: #f1f4f9; }
    .home:hover { background: #e7ecf4; color: #171a20; }
    .emoji { font-size: 2.6rem; margin: .5rem 0 0; }
    .name { margin: .7rem 0 0; font-size: 1.05rem; font-weight: 600; word-break: break-all; text-align: left; }
    .size { margin: .3rem 0 0; font-size: .85rem; color: #7a8190; }
    .actions { display: flex; flex-direction: column; gap: .6rem; margin-top: 1.2rem; }
    a.btn { display: flex; align-items: center; justify-content: center; gap: .45rem; width: 100%; padding: .95rem 0; font-size: 1.02rem; font-weight: 600; border-radius: 12px; border: 0; cursor: pointer; text-decoration: none; transition: transform .06s ease, filter .15s ease; }
    a.btn:active { transform: scale(.985); }
    a.btn.blue { background: linear-gradient(180deg, #57a0f5, #3d7ef0); color: #fff; box-shadow: 0 6px 16px rgba(61,126,240,.28); }
    a.btn.blue:hover { filter: brightness(1.06); }
    .note { margin: 1.1rem 0 0; font-size: .78rem; color: #98a1b0; }
  </style>
</head>
<body>
  <main class="card">
    <div class="top">
      <a class="brand" href="/"><img src="/favicon.svg" alt="" />文桥 ClipBridge</a>
      <a class="home" href="/">← 首页</a>
    </div>
    <p class="emoji">📄</p>
    <p class="name" id="name"></p>
    <p class="size" id="size"></p>
    <div class="actions">
      <a id="dl" class="btn blue" download>⬇️ 下载文件</a>
    </div>
    <p class="note">取件码 10 分钟内有效,到期自动销毁;可重复下载。</p>
  </main>
  <script>
    (function () {
      var meta = __META__;
      function fmtSize(n) {
        if (n >= 1000 * 1000) return (n / 1000 / 1000).toFixed(1) + ' MB';
        if (n >= 1000) return (n / 1000).toFixed(1) + ' KB';
        return n + ' B';
      }
      document.getElementById('name').textContent = meta.name;
      document.getElementById('size').textContent = fmtSize(meta.size);
      document.getElementById('dl').href = meta.url;
    })();
  </script>
</body>
</html>`;

// 取件码输入页:输满 4 位自动取件,回车或按钮亦可
const CLAIM_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>取件码取件</title>
  <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
  <style>
    [hidden] { display: none !important; }
    body { font-family: system-ui, -apple-system, "PingFang SC", "Segoe UI", sans-serif; margin: 0; padding: 2.5rem 1rem 3rem; color: #171a20; text-align: center; background-color: #f4f6fa; background-image: radial-gradient(720px 320px at 50% -60px, rgba(74,144,217,.16), rgba(74,144,217,0)); min-height: 100vh; -webkit-font-smoothing: antialiased; }
    .card { max-width: 430px; margin: 0 auto; background: #fff; border: 1px solid #e9edf4; border-radius: 20px; padding: 1.4rem 1.3rem 1.2rem; box-shadow: 0 12px 40px rgba(23,26,32,.07); }
    .top { display: flex; align-items: center; justify-content: space-between; margin-bottom: 1rem; }
    .brand { display: flex; align-items: center; gap: .45rem; font-size: .9rem; font-weight: 600; color: #171a20; text-decoration: none; }
    .brand img { width: 20px; height: 20px; border-radius: 5px; display: block; }
    .home { font-size: .82rem; color: #667085; text-decoration: none; padding: .32rem .75rem; border-radius: 999px; background: #f1f4f9; }
    .home:hover { background: #e7ecf4; color: #171a20; }
    h1 { font-size: 1.25rem; margin: .4rem 0 .9rem; }
    p { margin: .6rem 0 0; }
    #code { width: 9em; text-align: center; text-transform: uppercase; font-family: ui-monospace, monospace; letter-spacing: .3em; padding: .7rem .5rem .7rem .8em; font-size: 1.5rem; font-weight: 700; border: 1px solid #dfe5ee; border-radius: 14px; background: #f8fafd; }
    #code:focus { outline: none; border-color: #4a90d9; background: #fff; box-shadow: 0 0 0 3px rgba(74,144,217,.15); }
    .btn { display: block; width: 100%; margin-top: .9rem; padding: .95rem 0; font-size: 1.02rem; font-weight: 600; border-radius: 12px; border: 0; background: linear-gradient(180deg, #23272f, #15181d); color: #fff; cursor: pointer; transition: transform .06s ease, filter .15s ease; box-shadow: 0 6px 16px rgba(21,24,29,.22); }
    .btn:active { transform: scale(.985); }
    .btn:hover { filter: brightness(1.15); }
    #msg { min-height: 1.3em; margin: .5rem 0 0; font-size: .85rem; color: #b03a2e; }
    .note { font-size: .8rem; color: #98a1b0; margin: 1rem 0 0; }
  </style>
</head>
<body>
  <main class="card">
    <div class="top">
      <a class="brand" href="/"><img src="/favicon.svg" alt="" />文桥 ClipBridge</a>
      <a class="home" href="/">← 首页</a>
    </div>
    <h1>输入取件码</h1>
    <p><input id="code" placeholder="如 K7X2" maxlength="4" autocomplete="off" autofocus /></p>
    <p id="msg"></p>
    <button id="go" class="btn" type="button">取件</button>
    <p class="note">取件码 10 分钟内有效,取件即焚(仅能取一次)。</p>
  </main>
  <script>
    var code = document.getElementById('code');
    var go = document.getElementById('go');
    var msg = document.getElementById('msg');

    function doClaim() {
      var c = code.value.trim().toUpperCase();
      if (!c) { msg.textContent = '请输入取件码'; return; }
      if (!/^[A-HJKMNP-Z2-9]{4}$/.test(c)) {
        msg.textContent = '取件码为 4 位,且不含 I/L/O/0/1';
        return;
      }
      location.href = '/r/' + c;
    }

    code.addEventListener('input', function () {
      code.value = code.value.toUpperCase().replace(/[^A-HJKMNP-Z2-9]/g, '');
      msg.textContent = '';
      if (code.value.length === 4) doClaim(); // 输满 4 位自动取件
    });
    code.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') doClaim();
    });
    go.addEventListener('click', doClaim);
  </script>
</body>
</html>`;

// 取件失败页:取件码无效、已过期或已被取走
const INVALID_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>取件码无效</title>
  <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
  <style>
    [hidden] { display: none !important; }
    body { font-family: system-ui, -apple-system, "PingFang SC", "Segoe UI", sans-serif; margin: 0; padding: 2.5rem 1rem 3rem; color: #171a20; text-align: center; background-color: #f4f6fa; background-image: radial-gradient(720px 320px at 50% -60px, rgba(74,144,217,.16), rgba(74,144,217,0)); min-height: 100vh; -webkit-font-smoothing: antialiased; }
    .card { max-width: 430px; margin: 0 auto; background: #fff; border: 1px solid #e9edf4; border-radius: 20px; padding: 1.4rem 1.3rem 1.2rem; box-shadow: 0 12px 40px rgba(23,26,32,.07); }
    .top { display: flex; align-items: center; justify-content: space-between; margin-bottom: 1rem; }
    .brand { display: flex; align-items: center; gap: .45rem; font-size: .9rem; font-weight: 600; color: #171a20; text-decoration: none; }
    .brand img { width: 20px; height: 20px; border-radius: 5px; display: block; }
    .home { font-size: .82rem; color: #667085; text-decoration: none; padding: .32rem .75rem; border-radius: 999px; background: #f1f4f9; }
    .home:hover { background: #e7ecf4; color: #171a20; }
    .emoji { font-size: 2.4rem; margin: .6rem 0 0; }
    h1 { font-size: 1.25rem; margin: .5rem 0 .4rem; }
    p { margin: .45rem 0 0; font-size: .95rem; color: #5b6472; }
    .actions { margin-top: 1.4rem; }
    .btn { display: flex; align-items: center; justify-content: center; gap: .45rem; width: 100%; padding: .95rem 0; font-size: 1.02rem; font-weight: 600; border-radius: 12px; border: 0; cursor: pointer; text-decoration: none; transition: transform .06s ease, filter .15s ease; box-sizing: border-box; }
    .btn:active { transform: scale(.985); }
    a.btn.primary { background: linear-gradient(180deg, #1e293b, #0f172a); color: #fff; box-shadow: 0 4px 14px rgba(15,23,42,.18); }
    a.btn.primary:hover { filter: brightness(1.15); }
  </style>
</head>
<body>
  <main class="card">
    <div class="top">
      <a class="brand" href="/"><img src="/favicon.svg" alt="" />文桥 ClipBridge</a>
    </div>
    <p class="emoji">🤔</p>
    <h1>取件码无效或已过期</h1>
    <p>取件码 10 分钟内有效,且取件即焚(仅能取一次)。<br />请让发送方重新生成一个。</p>
    <div class="actions">
      <a class="btn primary" href="/">返回首页</a>
    </div>
  </main>
</body>
</html>`;

// 剪贴板频道页:配一次、以后免输码。__CHANNEL__ 注入频道码(或 null)。
// 服务端只发元数据,正文/文件按 id 单独取:轮询体积小,列表再长也不拖慢。
const CHANNEL_HTML_TEMPLATE = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>剪贴板频道</title>
  <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
  <style>
    [hidden] { display: none !important; }
    body { font-family: system-ui, -apple-system, "PingFang SC", "Segoe UI", sans-serif; margin: 0; padding: 2rem 1rem 3rem; color: #171a20; background-color: #f4f6fa; background-image: radial-gradient(720px 320px at 50% -60px, rgba(74,144,217,.16), rgba(74,144,217,0)); min-height: 100vh; -webkit-font-smoothing: antialiased; }
    .card { max-width: 480px; margin: 0 auto; background: #fff; border: 1px solid #e9edf4; border-radius: 20px; padding: 1.4rem 1.3rem 1.3rem; box-shadow: 0 12px 40px rgba(23,26,32,.07); }
    .top { display: flex; align-items: center; justify-content: space-between; margin-bottom: 1rem; }
    .brand { display: flex; align-items: center; gap: .45rem; font-size: .9rem; font-weight: 600; color: #171a20; text-decoration: none; }
    .brand img { width: 20px; height: 20px; border-radius: 5px; display: block; }
    .home { font-size: .82rem; color: #667085; text-decoration: none; padding: .32rem .75rem; border-radius: 999px; background: #f1f4f9; }
    .home:hover { background: #e7ecf4; color: #171a20; }
    h1 { font-size: 1.3rem; margin: .2rem 0 .5rem; }
    p { margin: .6rem 0 0; }
    .sub { font-size: .88rem; color: #667085; line-height: 1.5; }
    .btn { display: flex; align-items: center; justify-content: center; gap: .45rem; width: 100%; margin-top: .9rem; padding: .95rem 0; font-size: 1.02rem; font-weight: 600; border-radius: 12px; border: 0; cursor: pointer; text-decoration: none; box-sizing: border-box; transition: transform .06s ease, filter .15s ease; }
    .btn:active { transform: scale(.985); }
    .btn:disabled { opacity: .6; cursor: not-allowed; }
    .btn.primary { background: linear-gradient(180deg, #23272f, #15181d); color: #fff; box-shadow: 0 6px 16px rgba(21,24,29,.22); }
    .btn.primary:hover:not(:disabled) { filter: brightness(1.15); }
    .btn.quiet { background: #fff; border: 1.5px solid #bfdbfe; color: #1d4ed8; box-shadow: 0 2px 10px rgba(37,99,235,.08); }
    .btn.quiet:hover:not(:disabled) { background: #eff6ff; }
    .btn.mini { width: auto; margin: 0; padding: .5rem .8rem; font-size: .85rem; border-radius: 10px; background: #f1f4f9; color: #171a20; }
    .btn.mini:hover:not(:disabled) { background: #e7ecf4; }
    .btn.mini.copied { background: #ecfdf5; color: #047857; }
    .or { display: flex; align-items: center; gap: .6rem; margin: 1.1rem 0 .6rem; font-size: .8rem; color: #98a1b0; }
    .or::before, .or::after { content: ""; flex: 1; height: 1px; background: #eef1f6; }
    input[type="text"] { width: 100%; box-sizing: border-box; text-align: center; text-transform: uppercase; font-family: ui-monospace, monospace; letter-spacing: .24em; padding: .75rem .5rem .75rem .7rem; font-size: 1.15rem; font-weight: 700; border: 1px solid #dfe5ee; border-radius: 14px; background: #f8fafd; }
    input[type="text"]:focus { outline: none; border-color: #4a90d9; background: #fff; box-shadow: 0 0 0 3px rgba(74,144,217,.15); }
    textarea { width: 100%; box-sizing: border-box; min-height: 5.4rem; resize: vertical; padding: .8rem .9rem; font: inherit; font-size: .95rem; line-height: 1.5; border: 1px solid #dfe5ee; border-radius: 14px; background: #f8fafd; }
    textarea:focus { outline: none; border-color: #4a90d9; background: #fff; box-shadow: 0 0 0 3px rgba(74,144,217,.15); }
    .roomhead { display: flex; align-items: center; justify-content: space-between; gap: .6rem; padding: .55rem .8rem; background: #f8fafd; border: 1px solid #eef1f6; border-radius: 14px; }
    .roomhead .lbl { font-size: .74rem; color: #98a1b0; margin-right: .5rem; }
    .roomhead .code { font-family: ui-monospace, monospace; font-weight: 700; letter-spacing: .12em; }
    .tag { display: inline-block; margin-left: .5rem; padding: .1rem .42rem; border-radius: 999px; font-size: .68rem; background: #f1f4f9; color: #667085; vertical-align: 1px; }
    .tag.on { background: #ecfdf5; color: #047857; }
    .tag.off { background: #fef3f2; color: #b03a2e; }
    .row { display: flex; gap: .6rem; align-items: stretch; margin-top: .6rem; }
    .row .btn { margin-top: 0; }
    .filebtn { display: flex; align-items: center; justify-content: center; gap: .35rem; flex: 0 0 auto; padding: 0 .9rem; font-size: .88rem; font-weight: 600; border-radius: 12px; border: 1.5px solid #dfe5ee; background: #fff; color: #333; cursor: pointer; }
    .filebtn:hover { background: #f6f8fc; }
    .msg { min-height: 1.2em; font-size: .82rem; color: #667085; }
    .msg.err { color: #b03a2e; }
    .msg.ok { color: #147a4d; }
    .listhead { display: flex; align-items: center; justify-content: space-between; margin: 1.3rem 0 .5rem; font-size: .82rem; color: #667085; }
    .item { border: 1px solid #eef1f6; border-radius: 14px; padding: .7rem .8rem; margin-bottom: .6rem; background: #fff; }
    .item.new { animation: pop .7s ease; }
    @keyframes pop { from { background: #eff6ff; border-color: #bfdbfe; } to { background: #fff; border-color: #eef1f6; } }
    .item .meta { display: flex; justify-content: space-between; gap: .5rem; font-size: .74rem; color: #98a1b0; margin-bottom: .35rem; }
    .item .body { white-space: pre-wrap; word-break: break-all; font-size: .92rem; line-height: 1.5; max-height: 11rem; overflow: auto; }
    .item .acts { display: flex; gap: .5rem; align-items: center; margin-top: .55rem; }
    #qr { width: 190px; height: 190px; margin: .7rem auto 0; display: block; }
    .qbox { text-align: center; border: 1px solid #eef1f6; border-radius: 14px; padding: .6rem .8rem .9rem; margin-top: .7rem; background: #fbfcfe; }
    .qbox a { font-size: .78rem; color: #4a90d9; word-break: break-all; }
    .linkbtn { background: none; border: 0; padding: 0; font: inherit; font-size: .8rem; color: #4a90d9; cursor: pointer; }
    .linkbtn.warn { color: #b03a2e; }
    .footrow { display: flex; justify-content: space-between; gap: 1rem; margin-top: 1.1rem; }
    .note { font-size: .76rem; color: #98a1b0; line-height: 1.5; }
  </style>
</head>
<body>
  <main class="card">
    <div class="top">
      <a class="brand" href="/"><img src="/favicon.svg" alt="" />文桥 ClipBridge</a>
      <a class="home" href="/">← 首页</a>
    </div>

    <section id="pair" hidden>
      <h1>剪贴板频道</h1>
      <p class="sub">两台设备配对一次,之后互传文本/文件都不用再输码。</p>
      <p><button id="create" class="btn primary" type="button">创建新频道</button></p>
      <div class="or">或加入已有频道</div>
      <p><input id="joincode" type="text" inputmode="latin" placeholder="8 位频道码" maxlength="8" autocomplete="off" /></p>
      <p><button id="join" class="btn quiet" type="button">加入频道</button></p>
      <p id="pairmsg" class="msg"></p>
      <p class="note">频道码即凭证,有效期 24 小时,每次发送自动续期;请只分享给信任的设备。</p>
    </section>

    <section id="room" hidden>
      <div class="roomhead">
        <div><span class="lbl">频道码</span><span id="roomcode" class="code"></span><span id="link" class="tag">连接中…</span></div>
        <button id="qbtn" class="linkbtn" type="button">二维码配对</button>
      </div>
      <div id="qbox" class="qbox" hidden>
        <img id="qr" alt="频道配对二维码" />
        <p class="note">另一台设备扫码即可加入,也可以打开这个链接:</p>
        <p><a id="joinurl" href="#"></a></p>
      </div>

      <p><textarea id="t" placeholder="粘贴要同步到另一台设备的内容…"></textarea></p>
      <div class="row">
        <button id="send" class="btn primary" type="button">发送到频道</button>
        <label class="filebtn" for="f">📎 文件</label>
        <input id="f" type="file" hidden />
      </div>
      <p id="smsg" class="msg"></p>

      <div class="listhead">
        <span>频道内容(最近 20 条)</span>
        <button id="copynew" class="btn mini" type="button" hidden>📋 复制最新一条</button>
      </div>
      <div id="list"></div>
      <p id="empty" class="note">还没有内容。在任意一台已配对的设备上发送,这里会自动出现。</p>

      <div class="footrow">
        <button id="leave" class="linkbtn" type="button">退出本机频道</button>
        <button id="destroy" class="linkbtn warn" type="button">销毁频道</button>
      </div>
      <p class="note">内容在服务端保留 24 小时(每次发送续期),销毁后立即删除。</p>
    </section>

    <p id="err" class="msg err"></p>
  </main>
  <script>
    (function () {
      var LS_KEY = 'cb.channel';
      var POLL_MS = 2000;
      var injected = __CHANNEL__;
      var code = '';
      var seq = 0;
      var known = {};      // id -> element,增量渲染,轮询不会打断按钮反馈
      var payloads = {};   // id -> 正文文本(复制必须同步拿到,故先预取)
      var fetching = {};
      var textCount = 0;
      var timer = null;
      // 实时通道:连上 WebSocket 就是秒级推送;连不上/断了自动退回轮询,并指数退避重连
      var SAFETY_MS = 30000;   // WS 正常时的兜底轮询(推送万一丢了还能自愈)
      var WS_RETRY_MIN = 1000;
      var WS_RETRY_MAX = 20000;
      var PING_MS = 25000;
      var ws = null, wsRetry = 0, wsRetryTimer = null, pingTimer = null, pongTimer = null;
      var from = /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent) ? '手机' : '电脑';

      var pair = document.getElementById('pair');
      var room = document.getElementById('room');
      var pairmsg = document.getElementById('pairmsg');
      var errEl = document.getElementById('err');
      var create = document.getElementById('create');
      var joincode = document.getElementById('joincode');
      var join = document.getElementById('join');
      var roomcode = document.getElementById('roomcode');
      var qbtn = document.getElementById('qbtn');
      var qbox = document.getElementById('qbox');
      var qrimg = document.getElementById('qr');
      var joinurl = document.getElementById('joinurl');
      var t = document.getElementById('t');
      var send = document.getElementById('send');
      var fileInput = document.getElementById('f');
      var smsg = document.getElementById('smsg');
      var list = document.getElementById('list');
      var empty = document.getElementById('empty');
      var copynew = document.getElementById('copynew');
      var linkEl = document.getElementById('link');
      var newestText = null; // 最新一条文本的复制按钮:它才是「复制最新一条」该复制的东西
      var readies = {};      // id -> 该条正文就绪回调:推送把正文补上时直接用它启用复制按钮

      function save(c) { try { localStorage.setItem(LS_KEY, c); } catch (e) {} }
      function load() { try { return localStorage.getItem(LS_KEY) || ''; } catch (e) { return ''; } }
      function forget() { try { localStorage.removeItem(LS_KEY); } catch (e) {} }
      function setMsg(el, text, cls) { el.textContent = text; el.className = 'msg' + (cls ? ' ' + cls : ''); }
      function b64ok(c) { return /^[A-HJKMNP-Z2-9]{8}$/.test(c); }

      function fmtSize(n) {
        if (n >= 1000 * 1000) return (n / 1000 / 1000).toFixed(1) + ' MB';
        if (n >= 1000) return (n / 1000).toFixed(1) + ' KB';
        return n + ' B';
      }
      function fmtTime(ms) {
        var d = new Date(ms);
        var p = function (n) { return (n < 10 ? '0' : '') + n; };
        return p(d.getHours()) + ':' + p(d.getMinutes());
      }

      // 非安全上下文没有 Clipboard API 时退回 execCommand;必须在手势内同步调用
      function fallbackCopy(v) {
        try {
          var ta = document.createElement('textarea');
          ta.value = v;
          ta.setAttribute('readonly', '');
          ta.style.position = 'fixed';
          ta.style.top = '-1000px';
          ta.style.opacity = '0';
          document.body.appendChild(ta);
          ta.select();
          ta.setSelectionRange(0, v.length);
          var ok = document.execCommand('copy');
          document.body.removeChild(ta);
          return ok;
        } catch (e) { return false; }
      }

      function copyText(btn, value) {
        var label = btn.getAttribute('data-label') || btn.textContent;
        function finish(ok) {
          btn.textContent = ok ? '已复制 ✓' : (btn.getAttribute('data-fail') || '复制失败,请长按选择');
          btn.classList.toggle('copied', !!ok);
          clearTimeout(btn._copyTimer);
          btn._copyTimer = setTimeout(function () {
            btn.textContent = label;
            btn.classList.remove('copied');
          }, 1600);
        }
        var write = navigator.clipboard && navigator.clipboard.writeText
          ? navigator.clipboard.writeText(value)
          : Promise.reject();
        Promise.resolve(write).then(function () { finish(true); }, function () {
          finish(fallbackCopy(value));
        });
      }

      // 预取正文:让点击「复制」时的 writeText 处在手势内同步执行(iOS 必需)
      function fetchPayload(it, onReady) {
        if (payloads[it.id] !== undefined) { if (onReady) onReady(payloads[it.id]); return; }
        if (fetching[it.id]) return;
        fetching[it.id] = true;
        fetch('/c/' + code + '/e/' + encodeURIComponent(it.id), { cache: 'no-store' })
          .then(function (r) { if (!r.ok) throw new Error('gone'); return r.text(); })
          .then(function (text) {
            payloads[it.id] = text;
            delete fetching[it.id];
            if (onReady) onReady(text);
          }, function () { delete fetching[it.id]; if (onReady) onReady(null); });
      }

      function renderItem(it, isNew) {
        var el = document.createElement('div');
        el.className = 'item' + (isNew ? ' new' : '');
        var meta = document.createElement('div');
        meta.className = 'meta';
        var left = document.createElement('span');
        left.textContent = (it.from ? it.from + ' · ' : '') + fmtTime(it.at) + (it.kind === 'file' ? ' · 文件' : ' · 文本');
        var right = document.createElement('span');
        right.textContent = '# ' + it.seq;
        meta.appendChild(left);
        meta.appendChild(right);
        el.appendChild(meta);

        var body = document.createElement('div');
        body.className = 'body';
        el.appendChild(body);

        var acts = document.createElement('div');
        acts.className = 'acts';
        el.appendChild(acts);

        if (it.kind === 'file') {
          body.textContent = (it.name || 'file') + ' · ' + fmtSize(it.size || 0);
          var dl = document.createElement('a');
          dl.className = 'btn mini';
          dl.href = '/c/' + code + '/e/' + encodeURIComponent(it.id);
          dl.textContent = '⬇ 下载';
          acts.appendChild(dl);
        } else {
          textCount++;
          var copy = document.createElement('button');
          copy.className = 'btn mini';
          copy.type = 'button';
          copy.setAttribute('data-label', '📋 复制');
          copy.setAttribute('data-fail', '复制失败,请长按选择');
          copy.textContent = '载入中…';
          copy.disabled = true;
          var ready = function (text) {
            if (text === undefined || text === null) { copy.disabled = false; copy.textContent = '📋 重试载入'; return; }
            body.textContent = text;
            copy.disabled = false;
            copy.textContent = '📋 复制';
          };
          copy.addEventListener('click', function () {
            var v = payloads[it.id];
            if (v === undefined) { fetchPayload(it, ready); return; }
            copyText(copy, v); // 同步写入,保住用户激活
          });
          acts.appendChild(copy);
          readies[it.id] = ready;
          newestText = copy;
          body.textContent = it.preview || '';
          fetchPayload(it, ready);
        }
        known[it.id] = el;
        return el;
      }

      function updateEmpty() {
        empty.hidden = list.childElementCount > 0;
        copynew.hidden = textCount === 0;
      }

      function gone() {
        if (timer) { clearInterval(timer); timer = null; }
        stopSocket();
        setLink('');
        forget();
        resetRoom();
        room.hidden = true;
        pair.hidden = false;
        setMsg(errEl, '频道不存在、链接无效或已过期,请重新创建或输入频道码。', 'err');
      }

      // 进房间/频道失效时清干净:否则换一个频道后 since 还是旧值(新频道 seq 从 1 开始会被全部过滤掉),
      // 列表与 payloads 也会残留上一个频道的内容,「复制最新一条」可能复制到旧频道的东西。
      function resetRoom() {
        known = {};
        payloads = {};
        fetching = {};
        readies = {};
        textCount = 0;
        seq = 0;
        newestText = null;
        list.textContent = '';
        updateEmpty();
      }

      function applyItems(items) {
        var fresh = items.slice().sort(function (a, b) { return a.seq - b.seq; }); // 旧的先插,最新的落在最上面
        var any = false;
        for (var i = 0; i < fresh.length; i++) {
          var it = fresh[i];
          if (known[it.id]) continue;
          list.insertBefore(renderItem(it, true), list.firstChild);
          any = true;
        }
        updateEmpty();
        return any;
      }

      function tick() {
        if (!code || document.visibilityState === 'hidden') return;
        fetch('/api/channel/' + code + '?since=' + seq, { cache: 'no-store' })
          .then(function (r) {
            if (r.status === 404) { gone(); return null; }
            return r.json();
          })
          .then(function (j) {
            if (!j) return;
            setMsg(errEl, '');
            if (typeof j.seq === 'number') seq = j.seq;
            if (j.items && j.items.length) applyItems(j.items);
          }, function () { setMsg(errEl, '网络异常,正在自动重试…', 'err'); });
      }

      // 连接状态:● 实时(WS 已连)/ ○ 轮询中(WS 断了,退回轮询)/ 连接中…
      function setLink(text, cls) {
        linkEl.textContent = text;
        linkEl.className = 'tag' + (cls ? ' ' + cls : '');
      }

      // WS 连上时不再高频轮询,只保留 30 秒兜底;断开就回到 2 秒轮询
      function schedule() {
        if (timer) { clearInterval(timer); timer = null; }
        timer = setInterval(tick, ws && ws.readyState === 1 ? SAFETY_MS : POLL_MS);
      }

      function stopSocket() {
        clearTimeout(wsRetryTimer); wsRetryTimer = null;
        clearInterval(pingTimer); pingTimer = null;
        clearTimeout(pongTimer); pongTimer = null;
        wsRetry = 0;
        var s = ws;
        ws = null;
        if (s) { try { s.onclose = null; s.close(); } catch (e) {} }
      }

      function cleanupSocket(sock) {
        if (sock !== ws) return;
        ws = null;
        clearInterval(pingTimer); pingTimer = null;
        clearTimeout(pongTimer); pongTimer = null;
        if (!code || room.hidden) return;   // 已经不在房间里了,不必重连
        setLink('○ 轮询中');
        schedule();
        tick();
        wsRetry = Math.min(wsRetry ? wsRetry * 2 : WS_RETRY_MIN, WS_RETRY_MAX);
        clearTimeout(wsRetryTimer);
        wsRetryTimer = setTimeout(connect, wsRetry);
      }

      function connect() {
        if (!code || room.hidden) return;
        if (typeof WebSocket === 'undefined') { setLink('○ 轮询中'); return; }
        stopSocket();
        var sock;
        try {
          sock = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/api/channel/' + code + '/ws');
        } catch (e) { setLink('○ 轮询中'); return; }
        ws = sock;
        setLink('连接中…');
        sock.onopen = function () {
          wsRetry = 0;
          setLink('● 实时', 'on');
          schedule();
          tick();  // 连上先对齐一次,补上断开期间可能漏掉的条目
          clearInterval(pingTimer);
          pingTimer = setInterval(function () {
            if (sock.readyState !== 1) return;
            try { sock.send('{"type":"ping"}'); } catch (e) {}
            clearTimeout(pongTimer);
            pongTimer = setTimeout(function () {
              // 10 秒没回 pong:不等关闭握手(浏览器可能拖到 30 秒才给 onclose),立刻退回轮询并重连
              try { sock.close(); } catch (e) {}
              cleanupSocket(sock);
            }, 10000);
          }, PING_MS);
        };
        sock.onmessage = function (ev) {
          clearTimeout(pongTimer);
          var m;
          try { m = JSON.parse(ev.data); } catch (e) { return; }
          if (!m || m.type === 'ready' || m.type === 'pong') return;
          if (m.type === 'item' && m.item) {
            if (typeof m.text === 'string') {
              payloads[m.item.id] = m.text;                      // 正文随推送到达,复制按钮立刻可用
              if (readies[m.item.id]) readies[m.item.id](m.text); // 该条已渲染过:补上正文并启用复制
            }
            if (typeof m.item.seq === 'number' && m.item.seq > seq) seq = m.item.seq;
            applyItems([m.item]);
            return;
          }
          if (m.type === 'destroyed') { gone(); setMsg(errEl, '频道已被销毁。', 'err'); }
        };
        sock.onclose = function () { cleanupSocket(sock); };
        sock.onerror = function () { try { sock.close(); } catch (e) {} };
      }

      function start() {
        schedule();
        connect();
      }

      function enter(c) {
        code = c;
        save(c);
        resetRoom();
        pair.hidden = true;
        room.hidden = false;
        setMsg(errEl, '');
        roomcode.textContent = c;
        var url = location.origin + '/c/' + c;
        qrimg.src = '/?text=' + encodeURIComponent(url) + '&mode=text';
        joinurl.textContent = url;
        joinurl.href = url;
        tick();
        start();
      }

      create.addEventListener('click', function () {
        create.disabled = true;
        setMsg(pairmsg, '创建中…');
        fetch('/api/channel', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action: 'create' }),
        }).then(function (r) { return r.json(); }).then(function (j) {
          create.disabled = false;
          setMsg(pairmsg, '');
          if (j && j.code) enter(j.code);
          else setMsg(pairmsg, (j && j.error) || '创建失败,请重试', 'err');
        }, function () {
          create.disabled = false;
          setMsg(pairmsg, '网络错误,请重试', 'err');
        });
      });

      joincode.addEventListener('input', function () {
        joincode.value = joincode.value.toUpperCase().replace(/[^A-HJKMNP-Z2-9]/g, '');
      });
      function doJoin() {
        var c = joincode.value.trim().toUpperCase();
        if (!b64ok(c)) { setMsg(pairmsg, '频道码为 8 位,且不含 I/L/O/0/1', 'err'); return; }
        enter(c);
      }
      join.addEventListener('click', doJoin);
      joincode.addEventListener('keydown', function (e) { if (e.key === 'Enter') doJoin(); });

      function sendJson(json, okText) {
        send.disabled = true;
        setMsg(smsg, '发送中…');
        fetch('/api/channel', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(json),
        }).then(function (r) {
          return r.json().then(function (j) { return { status: r.status, body: j }; });
        }).then(function (res) {
          send.disabled = false;
          if (res.status !== 200) {
            setMsg(smsg, (res.body && res.body.error) || '发送失败,请重试', 'err');
            if (res.status === 404) gone();
            return;
          }
          setMsg(smsg, okText, 'ok');
          t.value = '';
          tick();
          setTimeout(function () {
            if (smsg.textContent === okText) setMsg(smsg, '');
          }, 1800);
        }, function () {
          send.disabled = false;
          setMsg(smsg, '网络错误,请重试', 'err');
        });
      }

      send.addEventListener('click', function () {
        var v = t.value.trim();
        if (!v) { setMsg(smsg, '请先粘贴或输入内容', 'err'); return; }
        if (new TextEncoder().encode(v).length > 32768) { setMsg(smsg, '内容超过 32KB 上限', 'err'); return; }
        sendJson({ action: 'send', code: code, text: v, from: from }, '已发送 ✓');
      });

      t.addEventListener('keydown', function (e) {
        if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') send.click();
      });

      // 文件:走与取件码一致的单次 POST(x-channel-code 指明频道)
      fileInput.addEventListener('change', function () {
        var f = fileInput.files && fileInput.files[0];
        if (!f) return;
        if (f.size > 25 * 1000 * 1000) { setMsg(smsg, '文件超过 25MB 上限', 'err'); fileInput.value = ''; return; }
        send.disabled = true;
        setMsg(smsg, '上传中 0%');
        var xhr = new XMLHttpRequest();
        xhr.open('POST', '/api/channel');
        xhr.setRequestHeader('content-type', f.type || 'application/octet-stream');
        xhr.setRequestHeader('x-channel-code', code);
        xhr.setRequestHeader('x-from', encodeURIComponent(from));
        try { xhr.setRequestHeader('x-file-name', encodeURIComponent(f.name)); } catch (e) {}
        xhr.upload.onprogress = function (e) {
          if (e.lengthComputable) setMsg(smsg, '上传中 ' + Math.round((e.loaded / e.total) * 100) + '%');
        };
        xhr.onload = function () {
          send.disabled = false;
          fileInput.value = '';
          var j = {};
          try { j = JSON.parse(xhr.responseText); } catch (e) {}
          if (xhr.status === 200) { setMsg(smsg, '已发送 ✓', 'ok'); tick(); }
          else {
            setMsg(smsg, j.error || '上传失败,请重试', 'err');
            if (xhr.status === 404) gone();
          }
        };
        xhr.onerror = function () {
          send.disabled = false;
          fileInput.value = '';
          setMsg(smsg, '网络错误,请重试', 'err');
        };
        xhr.send(f);
      });

      copynew.addEventListener('click', function () {
        // 只认最新那一条文本:它还没载入完就说清楚,绝不退而复制更旧的条目
        if (!newestText) { setMsg(smsg, '正文还在载入,请稍后再试', 'err'); return; }
        if (newestText.disabled) { setMsg(smsg, '最新一条的正文还在载入,请稍等一两秒再点', 'err'); return; }
        setMsg(smsg, '');
        newestText.click();
      });

      qbtn.addEventListener('click', function () { qbox.hidden = !qbox.hidden; });

      document.getElementById('leave').addEventListener('click', function () {
        forget();
        location.href = '/c';
      });

      document.getElementById('destroy').addEventListener('click', function () {
        if (!confirm('销毁频道?两端已同步的内容都会被删除,且无法恢复。')) return;
        fetch('/api/channel/' + code, { method: 'DELETE' }).then(function (r) { return r.json(); }).then(function () {
          gone();
          setMsg(errEl, '频道已销毁。', 'ok');
        }, function () { setMsg(errEl, '销毁失败,请重试', 'err'); });
      });

      document.addEventListener('visibilitychange', function () {
        if (document.visibilityState !== 'visible') return;
        tick();
        if (!ws) connect();  // 手机休眠后连接常常已经悄悄断了,回到前台主动重连
      });

      if (injected && b64ok(injected)) enter(injected);
      else {
        var saved = load();
        if (b64ok(saved)) enter(saved);
        else {
          pair.hidden = false;
          if (location.pathname !== '/c' && location.pathname !== '/c/') {
            setMsg(pairmsg, '频道链接无效,请重新配对。', 'err');
          }
        }
      }
    })();
  </script>
</body>
</html>`;

// 频道页:code 为 null 时渲染配对界面,否则直接进入该频道(扫码/链接配对)
function channelHtml(code: string | null): string {
  return CHANNEL_HTML_TEMPLATE.replace('__CHANNEL__', () => JSON.stringify(code));
}

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

function bridgeResponse(html: string): Response {
  return new Response(html, {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'public, max-age=300',
    },
  });
}

function randomCode(): string {
  let code = '';
  for (let i = 0; i < 4; i++) {
    code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  }
  return code;
}

// ---- 剪贴板频道:索引 + 独立正文键 ----
// 索引 c:CODE 只放元数据(小、轮询便宜),正文/文件放 c:CODE:e:ID(按需取)。
interface ChannelItem {
  id: string;
  seq: number;
  at: number;
  kind: 'text' | 'file';
  from?: string;
  name?: string;
  type?: string;
  size?: number;
  preview?: string;
}

interface ChannelDoc {
  v: 1;
  seq: number;
  updatedAt: number;
  items: ChannelItem[];
}

function randomChannelCode(): string {
  let code = '';
  for (let i = 0; i < CHANNEL_CODE_LENGTH; i++) {
    code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  }
  return code;
}

function channelKey(code: string): string {
  return CHANNEL_PREFIX + code;
}

function channelPayloadKey(code: string, id: string): string {
  return CHANNEL_PREFIX + code + CHANNEL_PAYLOAD_SEP + id;
}

function jsonNoStore(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

function channelNotFound(): Response {
  return errorJson('频道不存在或已过期', 404);
}

// 设备名只用于时间线标注,做白名单式清洗(去控制字符、截 12 字符)
function safeFrom(v: string | null | undefined): string | undefined {
  const s = (v ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 12);
  return s || undefined;
}

function decodeHeader(v: string | null): string | null {
  if (!v) return null;
  try {
    return decodeURIComponent(v);
  } catch {
    return v;
  }
}

async function readChannel(env: Env, code: string): Promise<ChannelDoc | null> {
  const doc = (await env.TRANSFERS.get(channelKey(code), 'json')) as unknown as ChannelDoc | null;
  if (!doc || typeof doc.seq !== 'number' || !Array.isArray(doc.items)) return null;
  return doc;
}

// id = 序号 + 4 位随机后缀:保序、频道内唯一,且不能靠猜拿到正文
function makeItemId(seq: number): string {
  let suffix = '';
  for (let i = 0; i < 4; i++) suffix += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  return `${seq}-${suffix}`;
}

// 追加一条:写正文键(带 TTL)→ 更新索引(带 TTL,每次发送续期)。
// 返回 null 表示频道不存在;文本条目把正文一并返回,便于实时通道随推送内联下发。
// 注意这是「读-改-写」且 KV 没有事务,同一频道并发写入要靠 Durable Object 串行化(见 ChannelRoom)。
async function appendChannelItem(
  env: Env,
  code: string,
  payload: { kind: 'text' | 'file'; text?: string; bytes?: ArrayBuffer; name?: string; type?: string; from?: string },
): Promise<{ item: ChannelItem; text?: string } | null> {
  const doc = await readChannel(env, code);
  if (!doc) return null;
  const seq = doc.seq + 1;
  const id = makeItemId(seq);
  const at = Date.now();
  const item: ChannelItem = { id, seq, at, kind: payload.kind, ...(payload.from ? { from: payload.from } : {}) };

  let value: string | ArrayBuffer;
  if (payload.kind === 'file') {
    const bytes = payload.bytes ?? new ArrayBuffer(0);
    item.name = payload.name ?? 'file';
    item.type = payload.type ?? 'application/octet-stream';
    item.size = bytes.byteLength;
    value = bytes;
  } else {
    const text = payload.text ?? '';
    item.preview = text.length > CHANNEL_PREVIEW_CHARS ? text.slice(0, CHANNEL_PREVIEW_CHARS) + '…' : text;
    value = text;
  }

  await env.TRANSFERS.put(channelPayloadKey(code, id), value, {
    expirationTtl: CHANNEL_TTL_SECONDS,
    metadata: { kind: item.kind, name: item.name, type: item.type },
  });

  const next: ChannelDoc = {
    v: 1,
    seq,
    updatedAt: at,
    items: [item, ...doc.items].slice(0, CHANNEL_MAX_ITEMS),
  };
  await env.TRANSFERS.put(channelKey(code), JSON.stringify(next), { expirationTtl: CHANNEL_TTL_SECONDS });
  return payload.kind === 'text' ? { item, text: payload.text ?? '' } : { item };
}

function appendResponse(res: { item: ChannelItem }): Response {
  return jsonNoStore({ ok: true, item: res.item, ttl: CHANNEL_TTL_SECONDS });
}

async function createChannel(env: Env, origin: string): Promise<Response> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const code = randomChannelCode();
    if ((await env.TRANSFERS.get(channelKey(code))) === null) {
      const doc: ChannelDoc = { v: 1, seq: 0, updatedAt: Date.now(), items: [] };
      await env.TRANSFERS.put(channelKey(code), JSON.stringify(doc), { expirationTtl: CHANNEL_TTL_SECONDS });
      return jsonNoStore({
        code,
        url: `${origin}/c/${code}`,
        ttl: CHANNEL_TTL_SECONDS,
        expiresAt: Date.now() + CHANNEL_TTL_SECONDS * 1000,
      });
    }
  }
  return errorJson('频道码生成失败,请重试', 500);
}

// 销毁:索引里存着正文 id,逐个删掉,不留孤儿(t: 的键完全不受影响)
async function destroyChannel(env: Env, code: string): Promise<Response> {
  const doc = await readChannel(env, code);
  if (!doc) return channelNotFound();
  await Promise.all(doc.items.map((it) => env.TRANSFERS.delete(channelPayloadKey(code, it.id))));
  await env.TRANSFERS.delete(channelKey(code));
  return jsonNoStore({ ok: true, deleted: doc.items.length });
}

async function channelPayloadResponse(env: Env, code: string, id: string): Promise<Response> {
  const entry = await env.TRANSFERS.getWithMetadata(channelPayloadKey(code, id), { type: 'arrayBuffer' });
  if (entry.value === null) return errorJson('内容不存在或已过期', 404);
  const meta = (entry.metadata ?? {}) as { kind?: string; name?: string; type?: string };
  if (meta.kind === 'file') {
    const name = meta.name ?? 'file';
    const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_') || 'file';
    return new Response(entry.value, {
      headers: {
        'content-type': meta.type ?? 'application/octet-stream',
        'content-disposition': `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`,
        'content-length': String(entry.value.byteLength),
        'cache-control': 'no-store',
      },
    });
  }
  return new Response(new TextDecoder().decode(entry.value), {
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
  });
}

// ── 实时通道(Durable Objects)────────────────────────────────────────────────
// 一个频道 = 一个 DO 实例(实例名就是频道码),它做三件事:
//   ① 串行化写入:KV 的「读索引 → 追加 → 写索引」没有事务,同秒并发会丢条目;
//      同一个 DO 内请求天然排队,写入不再互相覆盖。
//   ② 广播中心:持有该频道的所有 WebSocket 连接,新条目一落地就推给所有设备,
//      接收端不再等下一次轮询(KV 跨 colo 最长约 60s 见不到,这条路完全绕开)。
//   ③ 销毁通知:频道被销毁时立刻通知所有连接回到配对界面。
// 连接用 Hibernation API 持有:没有消息时 DO 会被换出内存,不产生常驻费用;
// 心跳 ping/pong 交给 setWebSocketAutoResponse 由运行时直接应答,连唤醒都省掉。
export class ChannelRoom {
  private state: DurableObjectState;
  private env: Env;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
    this.state.setWebSocketAutoResponse(new WebSocketRequestResponsePair('{"type":"ping"}', '{"type":"pong"}'));
  }

  async fetch(request: Request): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname.endsWith('/ws')) return this.upgrade(request);
    if (pathname.endsWith('/append')) return this.append(request);
    if (pathname.endsWith('/broadcast')) return this.broadcastItem(request);
    if (pathname.endsWith('/destroy')) return this.destroy(request);
    return errorJson('not found', 404);
  }

  // 升级:客户端一连上就先收到 ready,便于它立刻对齐一次索引
  private upgrade(request: Request): Response {
    if ((request.headers.get('upgrade') ?? '').toLowerCase() !== 'websocket') {
      return errorJson('需要 WebSocket 升级', 426);
    }
    const pair = new WebSocketPair();
    this.state.acceptWebSocket(pair[1]);
    pair[1].send(JSON.stringify({ type: 'ready' }));
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  // 心跳正常情况下由 setWebSocketAutoResponse 应答,这里只是兜底
  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message === 'string' && message.indexOf('ping') >= 0) {
      try {
        ws.send('{"type":"pong"}');
      } catch {
        /* 连接刚好断了,忽略 */
      }
    }
  }

  async webSocketClose(): Promise<void> {
    /* 无需处理:getWebSockets() 只返回还活着的连接 */
  }

  async webSocketError(): Promise<void> {}

  private fanout(payload: unknown): void {
    const data = JSON.stringify(payload);
    for (const ws of this.state.getWebSockets()) {
      try {
        ws.send(data);
      } catch {
        /* 单个连接坏了不影响其他设备 */
      }
    }
  }

  // 文本条目:DO 里串行完成 KV 读改写,正文随推送内联下发(另一端不用再取一次)
  private async append(request: Request): Promise<Response> {
    const body = (await request.json().catch(() => null)) as { code?: string; text?: string; from?: string } | null;
    const code = (body?.code ?? '').trim().toUpperCase();
    if (!body || !CHANNEL_CODE_RE.test(code)) return errorJson('频道码无效', 400);
    const res = await appendChannelItem(this.env, code, {
      kind: 'text',
      text: body.text ?? '',
      from: safeFrom(body.from),
    });
    if (!res) return channelNotFound();
    this.fanout({ type: 'item', item: res.item, text: res.text });
    return appendResponse(res);
  }

  // 文件条目:正文由 Worker 直接写 KV(几十 MB 不必穿过 DO),这里只负责通知
  private async broadcastItem(request: Request): Promise<Response> {
    const body = (await request.json().catch(() => null)) as { item?: ChannelItem } | null;
    if (!body?.item?.id) return errorJson('缺少 item', 400);
    this.fanout({ type: 'item', item: body.item });
    return jsonNoStore({ ok: true });
  }

  private async destroy(request: Request): Promise<Response> {
    const body = (await request.json().catch(() => null)) as { code?: string } | null;
    const code = (body?.code ?? '').trim().toUpperCase();
    if (!body || !CHANNEL_CODE_RE.test(code)) return errorJson('频道码无效', 400);
    const res = await destroyChannel(this.env, code);
    if (res.ok) this.fanout({ type: 'destroyed' });
    return res;
  }
}

// 取频道对应的 DO;未配置 CHANNELS 绑定时返回 null,调用方退化为纯 KV 路径
function channelRoom(env: Env, code: string): DurableObjectStub | null {
  if (!env.CHANNELS) return null;
  return env.CHANNELS.get(env.CHANNELS.idFromName(code));
}

// 文本写入交给 DO(串行 + 广播);没有绑定时退回本地 KV 写入
async function appendViaRoom(
  env: Env,
  code: string,
  text: string,
  from: string | undefined,
): Promise<Response> {
  const room = channelRoom(env, code);
  if (!room) {
    const res = await appendChannelItem(env, code, { kind: 'text', text, from });
    return res ? appendResponse(res) : channelNotFound();
  }
  try {
    return await room.fetch('https://channel-room/append', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code, text, from }),
    });
  } catch {
    // DO 不可用不该让发送失败:退回直接写 KV,接收端靠兜底轮询也能看到
    const res = await appendChannelItem(env, code, { kind: 'text', text, from });
    return res ? appendResponse(res) : channelNotFound();
  }
}

// 文件写完后通知房间里的其他设备;失败不影响发送结果
async function notifyRoom(env: Env, code: string, item: ChannelItem): Promise<void> {
  const room = channelRoom(env, code);
  if (!room) return;
  try {
    await room.fetch('https://channel-room/broadcast', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ item }),
    });
  } catch {
    /* 推送失败:接收端会靠兜底轮询补上 */
  }
}

function invalidClaim(): Response {
  return new Response(INVALID_HTML, {
    status: 404,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });
}

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const url = new URL(request.url);
    const params = url.searchParams;

    // 站点图标
    if (url.pathname === '/favicon.svg') {
      return new Response(FAVICON_SVG, {
        headers: {
          'content-type': 'image/svg+xml; charset=utf-8',
          'cache-control': 'public, max-age=604800',
        },
      });
    }

    // 复制中转页:扫码侧落地,内容自携带于查询参数
    if (url.pathname === '/t') {
      return bridgeResponse(bridgeHtml(null));
    }

    // 普通二维码生成页:纯前端实时出码
    if (url.pathname === '/qr') {
      return new Response(QR_HTML, {
        headers: { 'content-type': 'text/html; charset=utf-8' },
      });
    }

    // 取件码发送页:任意设备生成取件码,另一台设备凭码取件
    if (url.pathname === '/send') {
      return new Response(SEND_HTML, {
        headers: { 'content-type': 'text/html; charset=utf-8' },
      });
    }

    // 剪贴板频道页:配对一次后两端免输码(/c 配对,/c/CODE 扫码或链接配对)
    if (url.pathname === '/c' || url.pathname === '/c/') {
      return new Response(channelHtml(null), {
        headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
      });
    }
    if (url.pathname.startsWith('/c/')) {
      const rest = url.pathname.slice('/c/'.length);
      // 频道内正文/文件:/c/CODE/e/ID
      const payloadMatch = rest.match(/^([A-HJKMNP-Z2-9]{8})\/e\/([A-Za-z0-9-]{1,40})$/);
      if (payloadMatch) return channelPayloadResponse(env, payloadMatch[1], payloadMatch[2]);
      const channelCode = rest.trim().toUpperCase();
      if (CHANNEL_CODE_RE.test(channelCode)) {
        return new Response(channelHtml(channelCode), {
          headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
        });
      }
      // 格式不对的频道链接:回配对界面并提示(404 便于排查)
      return new Response(channelHtml(null), {
        status: 404,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      });
    }

    // 取件码输入页:不带码访问 /r 时
    if (url.pathname === '/r' || url.pathname === '/r/') {
      return new Response(CLAIM_HTML, {
        headers: { 'content-type': 'text/html; charset=utf-8' },
      });
    }

    // 取件:文本 → 取件即焚 + 内联中转页;文件 → 不消费取件码的下载页
    if (url.pathname.startsWith('/r/')) {
      // 文件字节流:完整交付整个文件时才焚毁;分片/HEAD 请求不焚毁
      if (url.pathname.endsWith('/download')) {
        if (request.method !== 'GET' && request.method !== 'HEAD') return invalidClaim();
        const dCode = url.pathname.slice(3, -'/download'.length).trim().toUpperCase();
        if (!/^[A-HJKMNP-Z2-9]{4}$/.test(dCode)) return invalidClaim();
        const entry = await env.TRANSFERS.getWithMetadata('t:' + dCode, { type: 'arrayBuffer' });
        if (entry.value === null || (entry.metadata as { kind?: string } | null)?.kind !== 'file') return invalidClaim();
        const meta = entry.metadata as { name: string; type: string };
        // content-disposition 的 ASCII 回退名:去掉非可打印字符
        const ascii = meta.name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_') || 'file';
        // 文件不焚毁:手机下载管理器普遍多请求(安全预取/探测/分片/重试),
        // 任何焚毁时机都会自相残杀。统一由 10 分钟 TTL 兜底销毁。
        const total = entry.value.byteLength;
        const headers: Record<string, string> = {
          'content-type': meta.type,
          'content-disposition': `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(meta.name)}`,
          'accept-ranges': 'bytes',
          'cache-control': 'no-store',
        };
        // 解析单区间 Range:多线程下载器(夸克/UC 等)会并发分片请求
        let start = 0;
        let end = total - 1;
        let partial = false;
        const rangeHdr = request.headers.get('range');
        const rangeMatch = rangeHdr ? rangeHdr.match(/^bytes=(\d*)-(\d*)$/) : null;
        if (rangeMatch && (rangeMatch[1] !== '' || rangeMatch[2] !== '')) {
          partial = true;
          if (rangeMatch[1] === '') {
            // bytes=-N:后缀区间
            start = Math.max(0, total - Number(rangeMatch[2]));
          } else {
            start = Number(rangeMatch[1]);
            end = rangeMatch[2] === '' ? total - 1 : Math.min(Number(rangeMatch[2]), total - 1);
          }
          if (start > end || start >= total) {
            return new Response(null, {
              status: 416,
              headers: { 'content-range': `bytes */${total}` },
            });
          }
        }
        const slice = partial ? entry.value.slice(start, end + 1) : entry.value;
        headers['content-length'] = String(end - start + 1);
        if (partial) headers['content-range'] = `bytes ${start}-${end}/${total}`;
        return new Response(request.method === 'HEAD' ? null : slice, {
          status: partial ? 206 : 200,
          headers,
        });
      }
      const code = url.pathname.slice(3).trim().toUpperCase();
      if (!/^[A-HJKMNP-Z2-9]{4}$/.test(code)) return invalidClaim();
      // 统一按二进制读;文本值是 UTF-8 字节,解码即可,无需区分存入形态
      const entry = await env.TRANSFERS.getWithMetadata('t:' + code, { type: 'arrayBuffer' });
      if (entry.value === null) return invalidClaim();
      const kind = (entry.metadata as { kind?: string } | null)?.kind ?? 'text';
      if (kind === 'file') {
        const meta = entry.metadata as { name: string };
        // 下载链接用相对路径:本地 dev 与线上各自指向当前域名,不会串
        return new Response(
          fileClaimPage({ name: meta.name, size: entry.value.byteLength, url: `/r/${code}/download` }),
          {
            headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
          },
        );
      }
      await env.TRANSFERS.delete('t:' + code);
      const text = new TextDecoder().decode(entry.value);
      const raw = new TextEncoder().encode(text);
      let d: string;
      let z = 0;
      try {
        const deflated = await deflateRaw(raw);
        if (deflated.length < raw.length) {
          d = toBase64Url(deflated);
          z = 1;
        } else {
          d = toBase64Url(raw);
        }
      } catch {
        d = toBase64Url(raw);
      }
      return bridgeResponse(bridgeHtml({ d, z }));
    }

    // 频道 API:JSON 走 create/send,裸二进制 + x-channel-code 走文件发送
    if (url.pathname === '/api/channel' && request.method === 'POST') {
      const contentType = request.headers.get('content-type') ?? '';
      if (!contentType.includes('application/json')) {
        const fileCode = (request.headers.get('x-channel-code') ?? '').trim().toUpperCase();
        if (!CHANNEL_CODE_RE.test(fileCode)) return errorJson('频道码无效', 400);
        const declared = Number(request.headers.get('content-length') ?? '0');
        if (declared > MAX_FILE_BYTES) return errorJson('文件超过 25MB 上限', 400);
        const buf = await request.arrayBuffer();
        if (buf.byteLength === 0) return errorJson('文件内容为空', 400);
        if (buf.byteLength > MAX_FILE_BYTES) return errorJson('文件超过 25MB 上限', 400);
        let name = 'file';
        try {
          name = decodeURIComponent(request.headers.get('x-file-name') ?? '') || 'file';
        } catch {
          name = 'file';
        }
        name = name.replace(/[\u0000-\u001f\u007f]/g, '').slice(-120) || 'file';
        const type = /^[\w.+-]+\/[\w.+-]+$/.test(contentType) ? contentType : 'application/octet-stream';
        // 文件正文由 Worker 直接写 KV(不穿过 DO),写完后通知房间里的其他设备
        const appended = await appendChannelItem(env, fileCode, {
          kind: 'file',
          bytes: buf,
          name,
          type,
          from: safeFrom(decodeHeader(request.headers.get('x-from'))),
        });
        if (!appended) return channelNotFound();
        await notifyRoom(env, fileCode, appended.item);
        return appendResponse(appended);
      }

      let body: { action?: string; code?: string; text?: string; from?: string };
      try {
        body = (await request.json()) as typeof body;
      } catch {
        return errorJson('请求体须为 JSON', 400);
      }
      if (body.action === 'create') return createChannel(env, url.origin);
      if (body.action === 'send') {
        const sendCode = (body.code ?? '').trim().toUpperCase();
        if (!CHANNEL_CODE_RE.test(sendCode)) return errorJson('频道码无效', 400);
        const text = (body.text ?? '').trim();
        if (!text) return errorJson('内容不能为空', 400);
        if (new TextEncoder().encode(text).length > TRANSFER_MAX_BYTES) return errorJson('内容超过 32KB 上限', 400);
        // 文本走 Durable Object:同一个频道串行写入,并立刻广播给所有连接
        return appendViaRoom(env, sendCode, text, safeFrom(body.from));
      }
      return errorJson('未知操作', 400);
    }

    if (url.pathname.startsWith('/api/channel/')) {
      let rest = url.pathname.slice('/api/channel/'.length);
      // 实时通道:/api/channel/:code/ws(WS 升级请求原样转发给 DO,保留 Upgrade 头)
      if (rest.endsWith('/ws')) {
        rest = rest.slice(0, -3);
        const wsCode = rest.trim().toUpperCase();
        if (!CHANNEL_CODE_RE.test(wsCode)) return errorJson('频道码无效', 400);
        const wsRoom = channelRoom(env, wsCode);
        if (!wsRoom) return errorJson('实时通道未启用', 503);
        if (request.method !== 'GET') return errorJson('不支持的请求方法', 405);
        if ((request.headers.get('upgrade') ?? '').toLowerCase() !== 'websocket') {
          return errorJson('需要 WebSocket 升级', 426);
        }
        return wsRoom.fetch(request);
      }
      const apiCode = rest.trim().toUpperCase();
      if (!CHANNEL_CODE_RE.test(apiCode)) return errorJson('频道码无效', 400);
      if (request.method === 'GET') {
        const doc = await readChannel(env, apiCode);
        if (!doc) return channelNotFound();
        const sinceNum = Number(params.get('since') ?? '0');
        const since = Number.isFinite(sinceNum) ? sinceNum : 0;
        return jsonNoStore({
          code: apiCode,
          seq: doc.seq,
          updatedAt: doc.updatedAt,
          ttl: CHANNEL_TTL_SECONDS,
          items: doc.items.filter((it) => it.seq > since),
        });
      }
      if (request.method === 'DELETE') {
        // 交给 DO:串行删除并立刻通知所有连接「频道没了」
        const room = channelRoom(env, apiCode);
        if (room) {
          try {
            return await room.fetch('https://channel-room/destroy', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ code: apiCode }),
            });
          } catch {
            /* DO 不可用时退回直接删除 */
          }
        }
        return destroyChannel(env, apiCode);
      }
      return errorJson('不支持的请求方法', 405);
    }

    // 生成取件码:application/json → 文本;其余 content-type → 二进制文件
    if (url.pathname === '/api/transfer' && request.method === 'POST') {
      const isFile = !(request.headers.get('content-type') ?? '').includes('application/json');
      let value: string | ArrayBuffer;
      let kind: 'text' | 'file';
      let fileMeta: { name: string; type: string } | undefined;

      if (isFile) {
        const declared = Number(request.headers.get('content-length') ?? '0');
        if (declared > MAX_FILE_BYTES) return errorJson('文件超过 25MB 上限', 400);
        const buf = await request.arrayBuffer();
        if (buf.byteLength === 0) return errorJson('文件内容为空', 400);
        if (buf.byteLength > MAX_FILE_BYTES) return errorJson('文件超过 25MB 上限', 400);
        let name = 'file';
        try {
          name = decodeURIComponent(request.headers.get('x-file-name') ?? '') || 'file';
        } catch {
          name = 'file';
        }
        // 去控制字符、截到末尾 120 字符(保住扩展名),metadata 上限 1024 字节
        name = name.replace(/[\u0000-\u001f\u007f]/g, '').slice(-120) || 'file';
        const typeHdr = request.headers.get('content-type') ?? '';
        const type = /^[\w.+-]+\/[\w.+-]+$/.test(typeHdr) ? typeHdr : 'application/octet-stream';
        value = buf;
        kind = 'file';
        fileMeta = { name, type };
      } else {
        let text: string;
        try {
          const body = (await request.json()) as { text?: string };
          text = (body.text ?? '').trim();
        } catch {
          return errorJson('请求体须为 JSON', 400);
        }
        if (!text) {
          return errorJson('内容不能为空', 400);
        }
        if (new TextEncoder().encode(text).length > TRANSFER_MAX_BYTES) {
          return errorJson('内容超过 32KB 上限', 400);
        }
        value = text;
        kind = 'text';
      }

      let code = '';
      for (let attempt = 0; attempt < 3; attempt++) {
        const candidate = randomCode();
        // 探测用 arrayBuffer:候选码若撞上已存的二进制值,按文本读会报错
        if ((await env.TRANSFERS.getWithMetadata('t:' + candidate, { type: 'arrayBuffer' })).value === null) {
          code = candidate;
          break;
        }
      }
      if (!code) {
        return errorJson('取件码生成失败,请重试', 500);
      }
      await env.TRANSFERS.put('t:' + code, value, {
        expirationTtl: TRANSFER_TTL_SECONDS,
        metadata: { kind, ...(fileMeta ?? {}) },
      });
      return new Response(JSON.stringify({ code, url: `${url.origin}/r/${code}`, kind }), {
        headers: { 'content-type': 'application/json; charset=utf-8' },
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
      // 默认走中转页(复制/打开由扫码者自选);mode=text 显式要求直出原文
      const content =
        (params.get('mode') ?? '').toLowerCase() === 'text'
          ? text
          : await bridgeContent(url.origin, text);
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
} satisfies ExportedHandler<Env>;
