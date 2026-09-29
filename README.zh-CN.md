# 二维码生成器

[English](./README.md) | [简体中文](./README.zh-CN.md)

> 跑在 Cloudflare Workers 上的无状态二维码生成服务——单文件、零成本、输出 SVG。
> 一次部署即得 `https://qr-generator.<你的子域>.workers.dev`,由全球边缘节点就近响应。

## 特性

- **SVG 输出** — 任意分辨率都清晰,`image/svg+xml` 响应,浏览器缓存 1 天
- **样式可调** — 模块像素尺寸、四周留白、前景/背景色、纠错等级
- **内置使用页** — 不带 `?text=` 访问根路径时,返回一个极简表单页,输入即出码
- **容错友好** — 越界数值自动夹取、非法颜色回退默认值,坏参数不会引发 500
- **CORS 全开** — `Access-Control-Allow-Origin: *`,任何来源都可嵌入调用
- **无状态 & 免费** — 不依赖数据库 / KV / R2,轻松运行在 Workers 免费额度内

## 快速开始

前置条件:Node.js ≥ 18(`node -v` 检查)和一个免费 [Cloudflare 账号](https://dash.cloudflare.com)。

```bash
npm install
npx wrangler login   # 浏览器授权,一次性
npm run dev          # 本地开发,http://localhost:8787
npm run deploy       # 部署到 https://qr-generator.<你的子域>.workers.dev
npm run tail         # 观察线上日志
```

部署出问题可回滚:`npx wrangler rollback`(部署历史自动保留)。

## API

```
GET /?text=...&size=...&margin=...&color=...&bg=...&ecl=...
```

| 参数 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `text` | string,**必填** | — | 要编码的内容,**必须 URL 编码**;上限 2000 字符 |
| `size` | int 1–20 | `8` | 每个模块的像素尺寸 |
| `margin` | int 0–10 | `2` | 四周留白,单位为模块数 |
| `color` | `#RGB` / `#RRGGBB` / `#RRGGBBAA` | `#000000` | 前景色 |
| `bg` | 同上 | `#ffffff` | 背景色 |
| `ecl` | `L` / `M` / `Q` / `H` | `M` | 纠错等级:越高越抗遮挡,但容量越小 |

响应约定:

- **成功** — `200`,`image/svg+xml`,带 `Cache-Control: public, max-age=86400` 与 `Access-Control-Allow-Origin: *`
- **请求有误** — `400`,`application/json`,形如 `{"error":"参数 text 不能为空"}`
- **无 `text` 参数** — `200`,`text/html`,返回内置使用页

### 调用示例

```bash
BASE=http://localhost:8787   # 上线后换成 workers.dev 地址

# 普通网址(这里手工做了百分号编码)
curl -s "$BASE/?text=https%3A%2F%2Fgithub.com" -o qr.svg

# 中文文本 —— curl 的 --data-urlencode 负责编码
curl -sG "$BASE/" --data-urlencode "text=你好,世界" -o zh.svg

# WiFi 配置,纠错等级调高
curl -sG "$BASE/" \
  --data-urlencode 'text=WIFI:T:WPA;S:Home;P:12345678;;' \
  --data-urlencode 'ecl=Q' -o wifi.svg

# 自定义样式:模块加大、换个颜色
curl -sG "$BASE/" \
  --data-urlencode "text=https://example.com" \
  --data-urlencode "size=12" --data-urlencode "color=#4A90D9" -o styled.svg
```

### 常用内容格式

```text
# WiFi(T:WPA / WEP / nopass)
WIFI:T:WPA;S:网络名;P:密码;;

# 电话 / 短信 / 邮件
tel:+8613800000000
SMSTO:+8613800000000:短信内容
mailto:hi@example.com?subject=你好

# 联系人 vCard 3.0(换行编码为 %0A)
BEGIN:VCARD%0AVERSION:3.0%0AFN:张三%0ATEL:+8613800000000%0AEND:VCARD
```

## 行为与限制

- `text` 上限 2000 字符,超出直接返回 `400`。**不做静默截断**——截断后的二维码扫出来内容是错的。
- 能容错的都容错:`size`/`margin` 越界自动夹取,非法颜色回退默认值,未知 `ecl` 回退 `M`;只有空 `text`、超长 `text`、或内容确实超出编码容量才返回 `400`。
- `text` 的值务必 URL 编码(`&`、`#`、空格、非 ASCII 字符都要),这是集成时的第一坑。
- 二维码是编码不是加密:内容人人可扫,不要编入密码等敏感信息(WiFi 码建议用访客网络)。

## 部署说明

- **自定义域名(可选)** — 域名 DNS 托管在 Cloudflare 时,在 `wrangler.jsonc` 增加如下配置后重新部署,证书自动签发:
  ```jsonc
  "routes": [{ "pattern": "qr.example.com", "custom_domain": true }]
  ```
- **免费额度** — 约 10 万请求/天、单次调用 10 ms CPU(截至 2026-09,以官方定价页为准),本玩具用量可忽略。
- **境内可达性** — workers.dev 子域在境内访问不稳定,绑自有域名通常更稳。

## 目录结构

```text
qr-generator/
├── src/index.ts      # 全部逻辑:解析参数 → uqr renderSVG → 返回响应
├── wrangler.jsonc    # Worker 配置
├── package.json
├── tsconfig.json
├── README.md         # 英文文档
└── README.zh-CN.md   # 本文件
```

## 实现说明

与原实施文档的两处小偏差,均为有意为之:

1. `@cloudflare/workers-types` 用 `^5` —— 当前 wrangler v4 将其声明为 peer 依赖,文档中的 `^4` 会让 `npm install` 直接失败。
2. 超过 2000 字符返回 `400`,而非静默截断 —— 原文档既要求截断、又要求 3000 字符时返回 `400`,两者本就矛盾;返回 `400` 对使用者更安全。

## 许可证

MIT —— 见仓库根目录的 [LICENSE](../LICENSE)。
