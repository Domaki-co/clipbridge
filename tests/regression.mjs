// 回归:QR 出码 → 真解码(jsQR) → 内容/桥接页验证
import jsQR from 'jsqr';
import { PNG } from 'pngjs';

const BASE = process.env.BASE || 'http://localhost:8787';

async function fetchSvg(path) {
  const res = await fetch(BASE + path);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${path}`);
  return res.text();
}

function decode(svg) {
  const total = Number(svg.match(/viewBox="0 0 (\d+) (\d+)"/)[1]);
  const seg = svg.match(/<path fill="[^"]*" d="([^"]+)"/)[1].match(/M(\d+),(\d+)h(\d+)v(\d+)h-\d+z/g);
  const cell = Number(seg[0].match(/h(\d+)v/)[1]);
  const cols = total / cell;
  const m = Array.from({ length: cols }, () => new Array(cols).fill(0));
  for (const s of seg) {
    const [, x, y] = s.match(/M(\d+),(\d+)/);
    m[Number(y) / cell][Number(x) / cell] = 1;
  }
  const n = m.length, quiet = 2, scale = 8;
  const size = (n + quiet * 2) * scale;
  const png = new PNG({ width: size, height: size });
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const my = Math.floor(y / scale) - quiet, mx = Math.floor(x / scale) - quiet;
      const dark = my >= 0 && my < n && mx >= 0 && mx < n && m[my][mx] === 1;
      const idx = (size * y + x) << 2;
      const v = dark ? 0 : 255;
      png.data[idx] = png.data[idx + 1] = png.data[idx + 2] = v;
      png.data[idx + 3] = 255;
    }
  }
  const r = jsQR(Uint8ClampedArray.from(png.data), png.width, png.height);
  if (!r) throw new Error('jsQR 无法解码');
  return r.data;
}

let failed = 0;
function check(name, cond, detail = '') {
  if (!cond) failed++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  ' + detail}`);
}

// 1. 默认桥接码:解码出 /t 链接,该链接返回新版中转页
const qr = decode(await fetchSvg('/?text=' + encodeURIComponent('https://github.com')));
check('默认码解码为桥接链接', qr.startsWith('http') && qr.includes('/t?d='), qr.slice(0, 60));
const tRes = await fetch(qr);
const tBody = await tRes.text();
check(
  '桥接页 200 + 新模板 + 复制按钮',
  tRes.status === 200 && tBody.includes('var init = null') && tBody.includes('复制全文'),
  `status=${tRes.status}`
);

// 2. mode=text 直出原文
const direct = decode(await fetchSvg('/?text=' + encodeURIComponent('你好,世界') + '&mode=text'));
check('mode=text 直出原文', direct === '你好,世界', direct.slice(0, 40));

// 3. WiFi + 纠错等级
const wifi = decode(await fetchSvg('/?text=' + encodeURIComponent('WIFI:T:WPA;S:Home;P:12345678;;') + '&ecl=Q&mode=text'));
check('WiFi 直出', wifi === 'WIFI:T:WPA;S:Home;P:12345678;;');

console.log(failed ? `\n${failed} 项失败` : '\n全部通过');
process.exit(failed ? 1 : 0);
