import { renderSVG } from 'uqr';

// uqr 0.1.3:renderSVG(data, options) 直接接受字符串并内部编码;
// SVG 相关选项:pixelSize(默认 10)、border(默认 1)、
// blackColor(默认 'black')、whiteColor(默认 'white')、ecc(默认 'L')

interface Env {
  TRANSFERS: KVNamespace;
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

const LANDING_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>文桥 ClipBridge · 文本同步</title>
  <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
  <style>
    [hidden] { display: none !important; }
    body { font-family: system-ui, -apple-system, "PingFang SC", "Segoe UI", sans-serif; margin: 0; padding: 2.5rem 1rem 3rem; color: #171a20; text-align: center; background-color: #f4f6fa; background-image: radial-gradient(720px 320px at 50% -60px, rgba(74,144,217,.16), rgba(74,144,217,0)); min-height: 100vh; -webkit-font-smoothing: antialiased; }
    .card { max-width: 430px; margin: 0 auto; background: #fff; border: 1px solid #e9edf4; border-radius: 20px; padding: 1.4rem 1.3rem 1.2rem; box-shadow: 0 12px 40px rgba(23,26,32,.07); }
    .top { display: flex; align-items: center; justify-content: space-between; margin-bottom: 1rem; }
    .brand { display: flex; align-items: center; gap: .45rem; font-size: .9rem; font-weight: 600; color: #171a20; text-decoration: none; }
    .brand img { width: 20px; height: 20px; border-radius: 5px; display: block; }
    .title { font-size: 1.25rem; margin: .4rem 0 .2rem; }
    p { margin: .6rem 0 0; }
    input[type="text"] { width: 100%; padding: .85rem 1rem; font-size: 1rem; box-sizing: border-box; border: 1px solid #dfe5ee; border-radius: 12px; background: #f8fafd; }
    input[type="text"]:focus { outline: none; border-color: #4a90d9; background: #fff; box-shadow: 0 0 0 3px rgba(74,144,217,.15); }
    #hint { min-height: 1.2em; margin: .55rem 0 0; font-size: .8rem; color: #8a93a3; }
    #qr { margin-top: 1.1rem; width: 240px; max-width: 100%; background: #fff; border: 1px solid #eef1f6; border-radius: 14px; padding: 10px; box-sizing: border-box; box-shadow: 0 8px 24px rgba(23,26,32,.08); }
    code { display: block; margin-top: .7rem; font-size: .78rem; color: #667085; word-break: break-all; }
    .nav { margin: 1rem 0 0; }
    .nav a { font-size: .82rem; color: #98a1b0; }
    .nav a:hover { color: #171a20; }
  </style>
</head>
<body>
  <main class="card">
    <div class="top"><span class="brand"><img src="/favicon.svg" alt="" />文桥 ClipBridge</span></div>
    <h1 class="title">文本,一扫即传</h1>
    <p><input id="text" type="text" placeholder="输入网址或文本,回车生成" /></p>
    <p id="hint"></p>
    <p><img id="qr" hidden alt="二维码预览" /></p>
    <code id="link"></code>
  </main>
  <p class="nav"><a href="/r">取件码取件</a> · <a href="/send">传文本到其他设备</a></p>
  <script>
    var input = document.getElementById('text');
    var img = document.getElementById('qr');
    var link = document.getElementById('link');
    var hint = document.getElementById('hint');

    // 所有码默认经中转页,复制还是打开由扫码的人自己选
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

// 取件码发送页:输入文本 → 生成 4 位取件码 + 取件链接 + 取件二维码
const SEND_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>传文本到其他设备</title>
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
    h1 { font-size: 1.25rem; margin: .1rem 0 .9rem; }
    p { margin: .6rem 0 0; }
    textarea { width: 100%; min-height: 9rem; padding: .8rem 1rem; font-size: 1rem; font-family: inherit; box-sizing: border-box; border: 1px solid #dfe5ee; border-radius: 12px; background: #f8fafd; resize: vertical; }
    textarea:focus { outline: none; border-color: #4a90d9; background: #fff; box-shadow: 0 0 0 3px rgba(74,144,217,.15); }
    .btn { display: block; width: 100%; margin-top: .8rem; padding: .95rem 0; font-size: 1.02rem; font-weight: 600; border-radius: 12px; border: 0; background: linear-gradient(180deg, #23272f, #15181d); color: #fff; cursor: pointer; transition: transform .06s ease, filter .15s ease; box-shadow: 0 6px 16px rgba(21,24,29,.22); }
    .btn:active { transform: scale(.985); }
    .btn:hover { filter: brightness(1.15); }
    .btn:disabled { opacity: .5; }
    #msg { min-height: 1.3em; margin: .5rem 0 0; font-size: .85rem; color: #b03a2e; }
    #progress { min-height: 1.2em; margin: .5rem 0 0; font-size: .82rem; color: #667085; }
    .or { display: flex; align-items: center; gap: .8rem; color: #98a1b0; font-size: .8rem; margin: 1.1rem 0 0; }
    .or::before, .or::after { content: ''; flex: 1; height: 1px; background: #e6eaf1; }
    .filebox { margin-top: .7rem; }
    .pickbtn { padding: .55rem 1.1rem; font-size: .9rem; border-radius: 10px; border: 1px dashed #c6cede; background: #f8fafd; color: #444; cursor: pointer; }
    .pickbtn:hover { border-color: #4a90d9; color: #1668b8; }
    .chip { display: inline-flex; align-items: center; gap: .5rem; max-width: 100%; padding: .45rem .85rem; background: #f1f5fb; border-radius: 999px; font-size: .85rem; }
    .chipname { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .chip button { border: 0; background: none; cursor: pointer; color: #7a8190; font-size: .9rem; padding: 0; }
    .step { margin: .2rem 0 0; font-size: .85rem; color: #667085; }
    a.claim { display: inline-block; margin: .3rem 0; font-size: .9rem; color: #1668b8; word-break: break-all; }
    #code { font-family: ui-monospace, monospace; font-size: 2rem; letter-spacing: .35em; margin-right: -.35em; font-weight: 700; color: #171a20; background: #f1f5fb; border: 1px dashed #c9d6ea; border-radius: 12px; padding: .6rem 0 .6rem .35em; }
    #qr { margin-top: .9rem; width: 230px; max-width: 100%; background: #fff; border: 1px solid #eef1f6; border-radius: 14px; padding: 10px; box-sizing: border-box; box-shadow: 0 8px 24px rgba(23,26,32,.08); }
    .note { font-size: .8rem; color: #98a1b0; margin: .9rem 0 0; }
    footer { margin-top: 1.4rem; font-size: .85rem; }
    footer a { color: #667085; }
  </style>
</head>
<body>
  <main class="card">
    <div class="top">
      <a class="brand" href="/"><img src="/favicon.svg" alt="" />文桥 ClipBridge</a>
      <a class="home" href="/">← 首页</a>
    </div>
    <h1>传文本 / 文件到其他设备</h1>
    <p><textarea id="text" placeholder="粘贴要传输的文本,生成取件码后到另一台设备打开取件链接…"></textarea></p>
    <p class="or"><span>或发送文件</span></p>
    <div class="filebox" id="filebox">
      <input type="file" id="file" hidden />
      <button id="pick" class="pickbtn" type="button">📎 选择文件(≤ 25MB)</button>
      <span id="chip" class="chip" hidden><span id="chipname" class="chipname"></span><button id="chipx" type="button" aria-label="移除文件">✕</button></span>
    </div>
    <p><button id="go" class="btn" type="button">生成取件码</button></p>
    <p id="progress"></p>
    <p id="msg"></p>
    <div id="result" hidden>
      <p class="step">在另一台设备:打开链接、扫码,或在首页输入取件码:</p>
      <p><a id="claimurl" class="claim" target="_blank" rel="noopener"></a></p>
      <p id="code"></p>
      <p><img id="qr" alt="取件二维码" /></p>
      <p class="note">取件码 10 分钟内有效;文本取件即焚,文件在下载后焚毁。</p>
    </div>
    <footer><a href="/">← 返回生成二维码</a></footer>
  </main>
  <script>
    var text = document.getElementById('text');
    var go = document.getElementById('go');
    var msg = document.getElementById('msg');
    var progress = document.getElementById('progress');
    var result = document.getElementById('result');
    var claimurl = document.getElementById('claimurl');
    var code = document.getElementById('code');
    var qr = document.getElementById('qr');
    var fileInput = document.getElementById('file');
    var pick = document.getElementById('pick');
    var chip = document.getElementById('chip');
    var chipname = document.getElementById('chipname');
    var filebox = document.getElementById('filebox');
    var currentFile = null;

    function fmtSize(n) {
      if (n >= 1000 * 1000) return (n / 1000 / 1000).toFixed(1) + ' MB';
      if (n >= 1000) return (n / 1000).toFixed(1) + ' KB';
      return n + ' B';
    }

    function setFile(f) {
      currentFile = f || null;
      if (currentFile) {
        document.getElementById('chipname').textContent = currentFile.name + ' · ' + fmtSize(currentFile.size);
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
    // 拖拽:防止浏览器直接打开文件,只接收第一个文件
    document.addEventListener('dragover', function (e) { e.preventDefault(); });
    document.addEventListener('drop', function (e) { e.preventDefault(); });
    filebox.addEventListener('drop', function (e) {
      if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]) setFile(e.dataTransfer.files[0]);
    });

    function showResult(j) {
      msg.textContent = '';
      progress.textContent = '';
      code.textContent = j.code.split('').join(' ');
      claimurl.textContent = j.url;
      claimurl.href = j.url;
      // 取件链接本身作为码内容直出(mode=text),扫码即达取件页
      qr.src = '/?text=' + encodeURIComponent(j.url) + '&mode=text';
      result.hidden = false;
    }

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

    go.addEventListener('click', function () {
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
    });
  </script>
</body>
</html>`;

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
      <a id="dl" class="btn blue">⬇️ 下载文件</a>
    </div>
    <p class="note">下载即焚:点击下载后此取件码失效,请保存好文件。</p>
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
    .actions { display: flex; flex-direction: column; gap: .6rem; margin-top: 1.2rem; }
    .btn { display: flex; align-items: center; justify-content: center; gap: .45rem; width: 100%; padding: .95rem 0; font-size: 1.02rem; font-weight: 600; border-radius: 12px; border: 0; cursor: pointer; text-decoration: none; transition: transform .06s ease, filter .15s ease; }
    .btn:active { transform: scale(.985); }
    a.btn.blue { background: linear-gradient(180deg, #57a0f5, #3d7ef0); color: #fff; box-shadow: 0 6px 16px rgba(61,126,240,.28); }
    a.btn.blue:hover { filter: brightness(1.06); }
    .btn.plain { background: #fff; border: 1px solid #dfe5ee; color: #333; }
    .btn.plain:hover { background: #f6f8fc; }
  </style>
</head>
<body>
  <main class="card">
    <div class="top">
      <a class="brand" href="/"><img src="/favicon.svg" alt="" />文桥 ClipBridge</a>
      <a class="home" href="/">← 首页</a>
    </div>
    <p class="emoji">🤔</p>
    <h1>取件码无效或已过期</h1>
    <p>取件码 10 分钟内有效,且取件即焚(仅能取一次)。<br />请让发送方重新生成一个。</p>
    <div class="actions">
      <a class="btn blue" href="/send">📨 去发送页</a>
      <a class="btn plain" href="/">返回首页</a>
    </div>
  </main>
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

    // 取件码发送页:任意设备生成取件码,另一台设备凭码取件
    if (url.pathname === '/send') {
      return new Response(SEND_HTML, {
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
      // 文件字节流:点击下载时才焚毁
      if (url.pathname.endsWith('/download')) {
        const dCode = url.pathname.slice(3, -'/download'.length).trim().toUpperCase();
        if (!/^[A-HJKMNP-Z2-9]{4}$/.test(dCode)) return invalidClaim();
        const entry = await env.TRANSFERS.getWithMetadata('t:' + dCode, { type: 'arrayBuffer' });
        if (entry.value === null || (entry.metadata as { kind?: string } | null)?.kind !== 'file') return invalidClaim();
        await env.TRANSFERS.delete('t:' + dCode);
        const meta = entry.metadata as { name: string; type: string };
        // content-disposition 的 ASCII 回退名:去掉非可打印字符
        const ascii = meta.name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_') || 'file';
        return new Response(entry.value, {
          headers: {
            'content-type': meta.type,
            'content-disposition': `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(meta.name)}`,
            'cache-control': 'no-store',
          },
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
        return new Response(
          fileClaimPage({ name: meta.name, size: entry.value.byteLength, url: `${url.origin}/r/${code}/download` }),
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
