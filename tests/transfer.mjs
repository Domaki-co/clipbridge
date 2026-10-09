// 取件码互传测试:生成 → 取件(内联载荷还原) → 阅后即焚 → 边界
const BASE = process.env.BASE || 'http://localhost:8787';
import zlib from 'node:zlib';

let failed = 0;
function check(name, cond, detail = '') {
  if (!cond) failed++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  ' + detail}`);
}

async function create(text) {
  const res = await fetch(BASE + '/api/transfer', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text }),
  });
  return { status: res.status, body: await res.json() };
}

// 1. 正常生成
const text = '你好,取件码!This is a bidirectional transfer test.\n第二行也要一致。';
const created = await create(text);
check(
  '生成取件码 200 + 格式',
  created.status === 200 &&
    /^[A-HJKMNP-Z2-9]{4}$/.test(created.body.code || '') &&
    (created.body.url || '').endsWith('/r/' + created.body.code),
  JSON.stringify(created.body).slice(0, 120)
);

// 2. 取件:页面内联载荷,还原后与原文一致
// (POST 返回的 url 是公开域名,本地测试时取件必须走 BASE——本地 KV 里才有这条数据)
const claimRes = await fetch(`${BASE}/r/${created.body.code}`);
const claimHtml = await claimRes.text();
const m = claimHtml.match(/var init = (\{.*?\});/);
let restored = null;
if (m) {
  const payload = JSON.parse(m[1]);
  const buf = Buffer.from(payload.d, 'base64url');
  restored = new TextDecoder().decode(payload.z === 1 ? zlib.inflateRawSync(buf) : buf);
}
check(
  '取件页 200 + 载荷还原一致',
  claimRes.status === 200 && claimHtml.includes('复制全文') && restored === text,
  `restored=${restored === null ? '(未解析到载荷)' : restored.slice(0, 40) + '…'}`
);

// 3. 阅后即焚:第二次取件应失败
const second = await fetch(`${BASE}/r/${created.body.code}`);
const secondHtml = await second.text();
check(
  '取件即焚:第二次 404 + 提示页',
  second.status === 404 && secondHtml.includes('无效或已过期'),
  `status=${second.status}`
);

// 4. 边界:空内容、超限内容
const empty = await create('   ');
check('空内容 400', empty.status === 400, `status=${empty.status}`);
const tooBig = await create('a'.repeat(40000));
check('超 32KB 400', tooBig.status === 400, `status=${tooBig.status}`);

// 5. 伪造取件码 → 404
const bogus = await fetch(BASE + '/r/ZZZZ');
check('无效取件码 404', bogus.status === 404);

// 6. 页面路由
const send = await fetch(BASE + '/send');
const sendHtml = await send.text();
check(
  '/send 页 200 + 含生成按钮与复制链接按钮',
  send.status === 200 && sendHtml.includes('生成取件码') && sendHtml.includes('id="copy-url-btn"')
);
const landing = await fetch(BASE + '/').then((r) => r.text());
check('使用页含 /send 入口', landing.includes('href="/send"'));
check('首页含生成取件码功能', landing.includes('生成取件码'));
check('首页含底部取件码输入框', landing.includes('id="claimcode"'));
check(
  '首页含「复制取件链接」按钮 + 复制逻辑',
  landing.includes('id="copy-url-btn"') &&
    landing.includes('复制取件链接') &&
    landing.includes("copyText(copyUrlBtn, currentClaimUrl)"),
  '缺少按钮或事件绑定'
);

const qrRes = await fetch(BASE + '/qr');
const qrHtml = await qrRes.text();
check('/qr 页 200 + 二维码生成功能', qrRes.status === 200 && qrHtml.includes('文本,一扫即传'));

console.log(failed ? `\n${failed} 项失败` : '\n全部通过');
process.exit(failed ? 1 : 0);
