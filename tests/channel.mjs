// 剪贴板频道测试:创建/配对 → 收发文本与文件 → 增量拉取 → 上限 → 销毁 → 取件码链路不受影响
const BASE = process.env.BASE || 'http://localhost:8787';

let failed = 0;
function check(name, cond, detail = '') {
  if (!cond) failed++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  ' + detail}`);
}

async function api(path, opts) {
  const res = await fetch(BASE + path, opts);
  let body = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { status: res.status, body, res };
}

function sendJson(payload) {
  return api('/api/channel', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

// 1. 创建频道
const created = await sendJson({ action: 'create' });
const code = created.body?.code || '';
check(
  '创建频道 200 + 8 位码 + 链接指向 /c/CODE',
  created.status === 200 &&
    /^[A-HJKMNP-Z2-9]{8}$/.test(code) &&
    (created.body.url || '').endsWith('/c/' + code) &&
    created.body.ttl === 86400,
  JSON.stringify(created.body).slice(0, 140)
);

// 2. 页面路由:配对页 / 带码配对页(注入频道码)
const pairPage = await fetch(BASE + '/c');
const pairHtml = await pairPage.text();
check(
  '/c 配对页 200 + 创建/加入入口 + localStorage 键',
  pairPage.status === 200 &&
    pairHtml.includes('创建新频道') &&
    pairHtml.includes('cb.channel') &&
    pairHtml.includes('id="joincode"')
);
const pairedPage = await fetch(BASE + '/c/' + code);
const pairedHtml = await pairedPage.text();
check(
  '/c/CODE 注入频道码(扫码即配对)',
  pairedPage.status === 200 && pairedHtml.includes(`var injected = "${code}"`) && pairedHtml.includes('id="room"')
);
const badLink = await fetch(BASE + '/c/XXXX');
check('无效频道链接 404 + 回配对界面', badLink.status === 404 && (await badLink.text()).includes('创建新频道'));

// 3. 空频道
const list0 = await api('/api/channel/' + code);
check('空频道 seq=0、items 为空', list0.status === 200 && list0.body.seq === 0 && list0.body.items.length === 0);

// 4. 发文本:索引只回元数据,正文单独按 id 取
const text1 = '第一条:剪贴板共享测试 ✓\n第二行也要一模一样。';
const sent1 = await sendJson({ action: 'send', code, text: text1, from: '电脑' });
const item1 = sent1.body?.item;
check(
  '发送文本 200 + 元数据(kind/seq/from/preview)',
  sent1.status === 200 &&
    item1?.kind === 'text' &&
    item1?.seq === 1 &&
    item1?.from === '电脑' &&
    (item1?.preview || '').startsWith('第一条'),
  JSON.stringify(sent1.body).slice(0, 140)
);
const list1 = await api(`/api/channel/${code}?since=0`);
check(
  '索引只回元数据 + 正文不在列表里',
  list1.status === 200 && list1.body.items.length === 1 && list1.body.items[0].text === undefined,
  JSON.stringify(list1.body).slice(0, 140)
);
const payload1 = await fetch(`${BASE}/c/${code}/e/${item1.id}`);
const text1Back = await payload1.text();
check(
  '正文按 id 取回一致',
  payload1.status === 200 && text1Back === text1 && (payload1.headers.get('content-type') || '').includes('text/plain'),
  `status=${payload1.status}`
);

// 5. 增量拉取:since 只回新条目
const sent2 = await sendJson({ action: 'send', code, text: '第二条', from: '手机' });
const list2 = await api(`/api/channel/${code}?since=1`);
check(
  'since 增量只回新条目且 seq 前进',
  sent2.status === 200 &&
    list2.body.seq === 2 &&
    list2.body.items.length === 1 &&
    list2.body.items[0].seq === 2 &&
    list2.body.items[0].from === '手机',
  JSON.stringify(list2.body).slice(0, 140)
);

// 6. 频道不焚毁(与一次性取件码的关键区别)
const listAgain = await api(`/api/channel/${code}`);
const payloadAgain = await fetch(`${BASE}/c/${code}/e/${item1.id}`);
check('频道内容可重复读取(不焚毁)', listAgain.body.items.length === 2 && payloadAgain.status === 200);

// 7. 文件:字节一致 + 附件头 + from
const fileBytes = Buffer.alloc(5000);
for (let i = 0; i < fileBytes.length; i++) fileBytes[i] = (i * 7 + 3) % 256; // 含 0x00 等任意字节
const up = await fetch(BASE + '/api/channel', {
  method: 'POST',
  headers: {
    'content-type': 'application/octet-stream',
    'x-channel-code': code,
    'x-file-name': encodeURIComponent('测试 文件.bin'),
    'x-from': encodeURIComponent('手机'),
  },
  body: fileBytes,
});
const upBody = await up.json();
check(
  '发送文件 200 + 名称/大小/来源',
  up.status === 200 &&
    upBody.item?.kind === 'file' &&
    upBody.item?.size === fileBytes.length &&
    upBody.item?.name === '测试 文件.bin' &&
    upBody.item?.from === '手机',
  JSON.stringify(upBody).slice(0, 140)
);
const dl = await fetch(`${BASE}/c/${code}/e/${upBody.item.id}`);
const dlBytes = Buffer.from(await dl.arrayBuffer());
const cd = dl.headers.get('content-disposition') || '';
check(
  '文件下载字节一致 + attachment 文件名(含中文)',
  dl.status === 200 && dlBytes.equals(fileBytes) && cd.includes('attachment') && cd.includes(encodeURIComponent('测试 文件.bin')),
  `status=${dl.status} cd=${cd}`
);
const list3 = await api(`/api/channel/${code}`);
check('索引含文件元数据且不含字节', list3.body.items.length === 3 && list3.body.items[0].kind === 'file');

// 8. 边界:空文本 / 超 32KB / 空文件 / 非法码 / 不存在的频道
check('空文本 400', (await sendJson({ action: 'send', code, text: '   ' })).status === 400);
check('超 32KB 400', (await sendJson({ action: 'send', code, text: 'a'.repeat(40000) })).status === 400);
check('未知 action 400', (await sendJson({ action: 'nope' })).status === 400);
check('频道码格式错误 400', (await api('/api/channel/XXXX')).status === 400);
check('不存在的频道 404', (await api('/api/channel/ABCDEFGH')).status === 404);
check('不存在频道的正文 404', (await fetch(`${BASE}/c/ABCDEFGH/e/1-ABCD`)).status === 404);
check('正文 id 非法 404', (await fetch(`${BASE}/c/${code}/e/..%2F..%2Fetc`)).status === 404);
const emptyFile = await fetch(BASE + '/api/channel', {
  method: 'POST',
  headers: { 'content-type': 'application/octet-stream', 'x-channel-code': code, 'x-file-name': 'a.bin' },
  body: new Uint8Array(0),
});
check('空文件 400', emptyFile.status === 400);

// 9. 上限:只保留最近 20 条
for (let i = 0; i < 21; i++) await sendJson({ action: 'send', code, text: '批量 ' + i });
const capped = await api(`/api/channel/${code}`);
const seqs = capped.body.items.map((it) => it.seq);
check(
  '索引上限 20 条:保留最新、丢掉最旧',
  capped.body.items.length === 20 && seqs[0] === 24 && seqs[19] === 5 && capped.body.seq === 24,
  `len=${capped.body.items.length} first=${seqs[0]} last=${seqs[19]}`
);

// 10. 销毁:索引与正文一并删除
const newestId = capped.body.items[0].id;
const del = await api('/api/channel/' + code, { method: 'DELETE' });
check('销毁 200 + 删除计数', del.status === 200 && del.body.deleted === 20, JSON.stringify(del.body));
check('销毁后列表 404', (await api('/api/channel/' + code)).status === 404);
check('销毁后正文 404', (await fetch(`${BASE}/c/${code}/e/${newestId}`)).status === 404);
check('销毁不存在的频道 404', (await api('/api/channel/' + code, { method: 'DELETE' })).status === 404);

// 11. 交叉回归:原有一次性取件码链路(取件即焚)不受频道影响
const legacy = await sendJson({ action: 'send', code: 'ZZZZZZZZ', text: 'x' }); // 只借道校验:频道码合法但不存在
const legacyCreate = await api('/api/transfer', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ text: '频道存在时取件码仍要照常焚毁' }),
});
const legacyClaim1 = await fetch(`${BASE}/r/${legacyCreate.body.code}`);
const legacyClaim2 = await fetch(`${BASE}/r/${legacyCreate.body.code}`);
check(
  '原有取件码链路不变(第一次 200、第二次 404)',
  legacy.status === 404 &&
    legacyCreate.status === 200 &&
    legacyClaim1.status === 200 &&
    legacyClaim2.status === 404,
  `legacy=${legacy.status} first=${legacyClaim1.status} second=${legacyClaim2.status}`
);

console.log(failed ? `\n${failed} 项失败` : '\n全部通过');
process.exit(failed ? 1 : 0);
