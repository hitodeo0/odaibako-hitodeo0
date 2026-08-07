// OGP画像（Twitterカードのサムネ）を自前生成するスクリプト。
//
// これまで GAS から HCTI API を呼んで画像を作っていた部分の置き換え。
// GitHub Actions 上でヘッドレスChrome(Puppeteer)を動かし、各メッセージの
// 本文を 1200x630 のPNGに描画して docs/og/ に保存する。
//
// 特徴:
//  - docs/messages/*.html の .message から「全文」を取り出して描画する
//    (list.json は表示用に30文字で切っているので使わない)
//  - すでにPNGがあるものはスキップ（差分だけ生成）
//  - 文字量に応じてフォントサイズを自動調整し、はみ出さないようにする
//  - 昔のページの og:image が hcti.io を指していたら、自分のPagesのURLに書き換える
//    （= HCTIへの依存を完全に外すための一度きりの移行処理も兼ねる）

import fs from "node:fs";
import path from "node:path";
import puppeteer from "puppeteer";

const ROOT = process.cwd();
const DOCS = path.join(ROOT, "docs");
const MESSAGES_DIR = path.join(DOCS, "messages");
const OG_DIR = path.join(DOCS, "og");
const LIST_JSON = path.join(DOCS, "list.json");

// GitHub Pages の公開URL（末尾スラッシュなし）
const SITE = "https://hitodeo0.github.io/odaibako-hitodeo0";

// Twitter/X 推奨サイズ
const WIDTH = 1200;
const HEIGHT = 630;

// カードが使える最大領域（画像端からの余白を確保）
const MAX_CARD_W = 1120;
const MAX_CARD_H = 550;

// フォント自動調整の範囲。
// FONT_MIN より小さくはしない。これ以上入らない文章は末尾を「…」で省略する。
const FONT_MAX = 64;
const FONT_MIN = 30;

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// list.json を読んで filename の重複を除いた配列を返す（先頭=新しい方を優先）
function readList() {
  const list = JSON.parse(fs.readFileSync(LIST_JSON, "utf8"));
  const seen = new Set();
  const unique = [];
  for (const item of list) {
    if (!item || !item.filename) continue;
    if (seen.has(item.filename)) continue;
    seen.add(item.filename);
    unique.push(item);
  }
  return unique;
}

// メッセージHTMLから本文(.message の中身)を取り出す。
// 中身はGAS側で既にHTMLエスケープ済みなので、そのままテンプレートに埋めてよい。
function extractMessageHtml(filename, fallback) {
  const p = path.join(MESSAGES_DIR, filename);
  if (!fs.existsSync(p)) return escapeHtml(fallback || "");
  const html = fs.readFileSync(p, "utf8");
  const m = html.match(/<div class="message">([\s\S]*?)<\/div>/);
  return m ? m[1] : escapeHtml(fallback || "");
}

function template(inner) {
  return `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <style>
    html, body {
      margin: 0;
      padding: 0;
      width: ${WIDTH}px;
      height: ${HEIGHT}px;
    }
    body {
      display: flex;
      align-items: center;
      justify-content: center;
      background: #ffffff;
      color: #191919;
      /* CI(Ubuntu)には fonts-noto-cjk / fonts-noto-color-emoji を入れる。
         Windowsでのローカル確認時は Yu Gothic / Segoe UI Emoji にフォールバックする。 */
      font-family: 'Noto Sans JP', 'Noto Sans CJK JP', 'Noto Color Emoji',
                   'Segoe UI Emoji', 'Yu Gothic', 'Meiryo', sans-serif;
    }
    .card {
      box-sizing: border-box;
      width: fit-content;
      max-width: ${MAX_CARD_W}px;
      padding: 48px;
      background: #e4e4e4;
      border-radius: 16px;
      line-height: 1.6;
      text-align: left;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }
  </style>
</head>
<body>
  <div class="card">${inner}</div>
</body>
</html>`;
}

// 文字量に応じてフォントサイズを縮めて、カードが領域に収まるようにする。
// FONT_MIN まで縮めても入りきらない場合は、末尾を「…」で省略して収める。
async function autofit(page) {
  await page.evaluate(
    (maxW, maxH, fontMax, fontMin) => {
      const card = document.querySelector(".card");
      const fits = () =>
        card.offsetHeight <= maxH && card.offsetWidth <= maxW;

      // まずフォントサイズを FONT_MIN まで段階的に縮める
      let size = fontMax;
      card.style.fontSize = size + "px";
      while (size > fontMin && !fits()) {
        size -= 2;
        card.style.fontSize = size + "px";
      }

      // FONT_MIN でも入らないなら、末尾を削って「…」を付ける（二分探索で最長を探す）
      if (!fits()) {
        const chars = Array.from(card.textContent);
        const build = (n) =>
          chars.slice(0, n).join("").replace(/\s+$/, "") + "…";
        let best = 0;
        let low = 1;
        let high = chars.length;
        while (low <= high) {
          const mid = (low + high) >> 1;
          card.textContent = build(mid);
          if (fits()) {
            best = mid;
            low = mid + 1;
          } else {
            high = mid - 1;
          }
        }
        card.textContent = build(best);
      }
    },
    MAX_CARD_W,
    MAX_CARD_H,
    FONT_MAX,
    FONT_MIN,
  );
}

async function main() {
  fs.mkdirSync(OG_DIR, { recursive: true });
  const list = readList();

  const browser = await puppeteer.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  let generated = 0;
  let migrated = 0;

  for (const item of list) {
    const base = item.filename.replace(/\.html$/, "");
    const pngPath = path.join(OG_DIR, base + ".png");
    const htmlPath = path.join(MESSAGES_DIR, item.filename);

    // 昔のページの og:image を自分のPagesのURLに書き換える（HCTI依存を外す）
    if (fs.existsSync(htmlPath)) {
      const html = fs.readFileSync(htmlPath, "utf8");
      const selfUrl = `${SITE}/og/${base}.png`;
      const replaced = html.replace(
        /(<meta property="og:image" content=")[^"]*(">)/,
        `$1${selfUrl}$2`,
      );
      if (replaced !== html) {
        fs.writeFileSync(htmlPath, replaced);
        migrated++;
      }
    }

    // PNGが既にあれば生成しない
    if (fs.existsSync(pngPath)) continue;

    const inner = extractMessageHtml(item.filename, item.message);
    const page = await browser.newPage();
    await page.setViewport({
      width: WIDTH,
      height: HEIGHT,
      deviceScaleFactor: 1,
    });
    await page.setContent(template(inner), { waitUntil: "load" });
    await autofit(page);
    const buf = await page.screenshot({
      type: "png",
      clip: { x: 0, y: 0, width: WIDTH, height: HEIGHT },
    });
    fs.writeFileSync(pngPath, buf);
    await page.close();
    generated++;
    console.log("generated:", base + ".png");
  }

  await browser.close();
  console.log(`done. generated=${generated}, migrated(og:image)=${migrated}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
