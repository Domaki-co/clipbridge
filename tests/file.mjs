// 文件传输测试:二进制上传 → 取件页 → 下载还原 → 下载即焚 → 边界
const BASE = process.env.BASE || 'http://localhost:8787';
import zlib from 'node:zlib';

let failed = 0;
function check(name, cond, detail = '') {
  if (!cond) failed++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  ' + detail}`);
}

async function uploadFile(name, type, body) {
  const headers = { 'x-file-name': encodeURIComponent(name) };
  if (type) headers['content-type'] = type;
  const res = await fetch(BASE + '/api/transfer', { method: 'POST', headers, body });
  return { status: res.status, body: await res.json() };
}

// 1. 上传带中文名的"PDF"(内容含多字节字符与二进制感)
const content = Buffer.concat([
  Buffer.from('%PDF-1.4 假装是报告 '),
  Buffer.from([0x00, 0xff, 0x11, 0x22, 0xfe]),
  Buffer.from('重复内容让文件不至于太小。'.repeat(50)),
  Buffer.from([0x03, 0x9a, 0xd4]),
]);
const up = await uploadFile('项目报告 v2.pdf', 'application/pdf', content);
check(
  '文件上传 200 + kind=file',
  up.status === 200 && up.body.kind === 'file' && /^[A-HJKMNP-Z2-9]{4}$/.test(up.body.code || ''),
  JSON.stringify(up.body).slice(0, 120)
);

// 2. 取件页:文件名 + 大小 + 下载按钮(不消费取件码;本地测试走 BASE,数据在本地 KV)
const claimRes = await fetch(`${BASE}/r/${up.body.code}`);
const claimHtml = await claimRes.text();
const metaMatch = claimHtml.match(/var meta = (\{.*?\});/);
let meta = null;
if (metaMatch) { try { meta = JSON.parse(metaMatch[1]); } catch (e) {} }
check(
  '文件取件页 200 + 名称/大小/下载链接',
  claimRes.status === 200 &&
    claimHtml.includes('下载文件') &&
    meta && meta.name === '项目报告 v2.pdf' && meta.size === content.length &&
    meta.url.endsWith('/r/' + up.body.code + '/download'),
  JSON.stringify(meta)
);

// 3. 重复打开取件页不消费(刷新安全)
const again = await fetch(`${BASE}/r/${up.body.code}`);
check('取件页可重复打开', again.status === 200);

// 3.5 HEAD 与 Range:多线程下载器(夸克/UC)的分片与探测请求不触发焚毁
const headRes = await fetch(`${BASE}/r/${up.body.code}/download`, { method: 'HEAD' });
check(
  'HEAD 200 + accept-ranges + content-length + 不焚毁',
  headRes.status === 200 &&
    headRes.headers.get('accept-ranges') === 'bytes' &&
    headRes.headers.get('content-length') === String(content.length),
  `status=${headRes.status} ar=${headRes.headers.get('accept-ranges')}`
);
const r1 = await fetch(`${BASE}/r/${up.body.code}/download`, { headers: { range: 'bytes=0-99' } });
const r1buf = Buffer.from(await r1.arrayBuffer());
check(
  'Range 206 + 分片正确 + 不焚毁',
  r1.status === 206 &&
    r1buf.length === 100 &&
    r1buf.equals(content.subarray(0, 100)) &&
    (r1.headers.get('content-range') || '').endsWith(`/${content.length}`),
  `status=${r1.status} len=${r1buf.length} cr=${r1.headers.get('content-range')}`
);
const r2 = await fetch(`${BASE}/r/${up.body.code}/download`, { headers: { range: 'bytes=-10' } });
const r2buf = Buffer.from(await r2.arrayBuffer());
check('后缀 Range(bytes=-10)206 + 内容正确', r2.status === 206 && r2buf.equals(content.subarray(-10)));
const r3 = await fetch(`${BASE}/r/${up.body.code}/download`, { headers: { range: 'bytes=100-199' } });
const r3buf = Buffer.from(await r3.arrayBuffer());
check('中段 Range 206(多线程并发可用)', r3.status === 206 && r3buf.equals(content.subarray(100, 200)));
const probe = await fetch(`${BASE}/r/${up.body.code}/download`, { headers: { range: 'bytes=0-' } });
const probeBuf = Buffer.from(await probe.arrayBuffer());
check('bytes=0- 探测:206 全量 + 不焚毁(两段式内核)', probe.status === 206 && probeBuf.equals(content));
const multi = await fetch(`${BASE}/r/${up.body.code}/download`, { headers: { range: 'bytes=0-1,5-9' } });
check('多区间 Range 忽略:200 全量 + 不焚毁', multi.status === 200 && (await multi.arrayBuffer()).byteLength === content.length);

// 4. 下载:字节完全一致 + 响应头保留类型与文件名(完整交付后焚毁)
const dlRes = await fetch(`${BASE}/r/${up.body.code}/download`);
const dlBuf = Buffer.from(await dlRes.arrayBuffer());
const identical = dlBuf.length === content.length && dlBuf.equals(content);
check(
  '下载字节一致 + 头部正确',
  dlRes.status === 200 &&
    identical &&
    (dlRes.headers.get('content-type') || '').includes('application/pdf') &&
    (dlRes.headers.get('content-disposition') || '').includes(encodeURIComponent('项目报告 v2.pdf')),
  `len=${dlBuf.length}/${content.length} identical=${identical} cd=${dlRes.headers.get('content-disposition')}`
);

// 5. TTL 内可重复下载(文件不焚毁,由 10 分钟 TTL 兜底)
const dl2 = await fetch(`${BASE}/r/${up.body.code}/download`);
const dl2buf = Buffer.from(await dl2.arrayBuffer());
check('重复下载 200 + 字节一致', dl2.status === 200 && dl2buf.equals(content), `status=${dl2.status}`);

// 6. 文本取件码没有 /download 路由
const textUp = await fetch(BASE + '/api/transfer', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ text: '纯文本取件码' }),
}).then((r) => r.json());
const textDl = await fetch(`${BASE}/r/${textUp.code}/download`);
check('文本码无下载路由 404', textDl.status === 404, `status=${textDl.status}`);

// 7. 超限文件 400(25MB+)
const big = await uploadFile('big.bin', 'application/octet-stream', Buffer.alloc(25 * 1000 * 1000 + 1, 7));
check('超 25MB 400', big.status === 400, `status=${big.status}`);

// 8. 空文件 400
const empty = await uploadFile('empty.bin', '', Buffer.alloc(0));
check('空文件 400', empty.status === 400, `status=${empty.status}`);

// 9. 文本链路回归(上传分支没有破坏 JSON 路径)
const textRound = await fetch(`${BASE}/r/${textUp.code}`);
const textHtml = await textRound.text();
const m = textHtml.match(/var init = (\{.*?\});/);
let restored = null;
if (m) {
  const payload = JSON.parse(m[1]);
  const buf = Buffer.from(payload.d, 'base64url');
  restored = new TextDecoder().decode(payload.z === 1 ? zlib.inflateRawSync(buf) : buf);
}
check('文本链路回归:取件还原一致', restored === '纯文本取件码', `restored=${restored}`);

console.log(failed ? `\n${failed} 项失败` : '\n全部通过');
process.exit(failed ? 1 : 0);
