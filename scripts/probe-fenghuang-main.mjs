#!/usr/bin/env node
/**
 * probe-fenghuang-main.mjs — 找「鳳凰衛視（綜合台）」的獨立來源
 *
 * 背景（第 4 輪巡檢）：
 *   `cn-fh`（鳳凰衛視）與 `cn-fhzw`（鳳凰衛視中文台）的 stream_url **完全相同**
 *   （`120.198.95.220:9901/tsfile/live/1036_1.m3u8`）。
 *   上游 itvlist 的名稱↔網址配對顯示 `1036_1` = **凤凰中文**（= 中文台）。
 *   → 鳳凰衛視這個頻道目前沒有自己的來源，使用者看到的是重複內容。
 *
 * 上游清單（fanmingming / suxuang / asdjkl6）一致區分：
 *   · 凤凰卫视（綜合台，main）
 *   · 凤凰中文（中文台）
 *   · 凤凰资讯（資訊台）
 *   · 凤凰香港（香港台）
 *
 * 這支探測「凤凰卫视（main）」的候選來源。
 */

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36';

const CANDIDATES = [
  // ── 鳳凰官方 ifeng CDN（上游清單最常見的來源）─────────────────
  ['ifeng tv1', 'http://playtv-live.ifeng.com/live/06OLEGEGM4G_tv1.m3u8'],
  ['ifeng tv1 https', 'https://playtv-live.ifeng.com/live/06OLEGEGM4G_tv1.m3u8'],
  ['ifeng tv2', 'http://playtv-live.ifeng.com/live/06OLEGEGM4G_tv2.m3u8'],
  ['ifeng play-live tv1', 'http://play-live.ifeng.com/live/06OLEGEGM4G_tv1.m3u8'],
  ['ifeng base', 'http://playtv-live.ifeng.com/live/06OLEGEGM4G.m3u8'],
  ['ifeng 中文 tv1（對照）', 'http://playtv-live.ifeng.com/live/06OLEGEGM4G.m3u8'],

  // ── 其他上游清單裡標為「凤凰卫视」的來源 ──────────────────────
  ['lzu6 hls254', 'http://hdtv.lzu6.edu.cn/hls/hls254.m3u8'],
  ['haust fhzw（中文 對照）', 'http://hdtv.haust.edu.cn/hls/fhzw.m3u8'],
  ['ahcme fhzw（中文 對照）', 'https://itv.ahcme.edu.cn/hls/fhzw.m3u8'],
  ['jxtv 3221225900（凤凰卫视）', 'http://112.50.243.8/PLTV/88888888/224/3221225900/1.m3u8'],
  ['zj cm 3221226368（中文 對照）', 'http://112.17.40.140/PLTV/88888888/224/3221226368/index.m3u8'],
  ['zj cm 3221228608（中文 對照）', 'http://111.0.93.5:80/hwltc.tv.cdn.zj.chinamobile.com/PLTV/88888888/224/3221228608/01.m3u8'],
  ['ah 27.41.245.32 205（中文 對照）', 'http://27.41.245.32:801/hls/205/index.m3u8'],
  ['CM 3221225942（中文 對照）', 'http://otttv.bj.chinamobile.com/TVOD/88888888/224/3221225942/1.m3u8'],

  // ── 鳳凰香港（與 main 不同，僅作命名空間對照）─────────────────
  ['CM 3221226251（香港）', 'http://hwrr.jx.chinamobile.com:8080/PLTV/88888888/224/3221226251/index.m3u8'],
  ['CM 3221228057（中文）', 'http://223.110.235.3/ott.js.chinamobile.com/PLTV/3/224/3221228057/index.m3u8'],
];

async function probe(url) {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Origin: 'https://taiwan-live-tv.netlify.app' },
      redirect: 'follow',
      signal: AbortSignal.timeout(15000),
    });
    const buf = Buffer.from(await res.arrayBuffer());
    const text = buf.toString('utf8');
    const isM = text.trimStart().startsWith('#EXTM3U');
    return {
      status: res.status,
      isManifest: isM,
      bytes: buf.length,
      cors: res.headers.get('access-control-allow-origin'),
      seq: (text.match(/^#EXT-X-MEDIA-SEQUENCE:(\d+)/m) || [])[1] ?? null,
      endlist: text.includes('#EXT-X-ENDLIST'),
      final: res.url,
    };
  } catch (e) {
    return { status: 0, isManifest: false, error: e.name ?? e.message };
  }
}

for (const [name, url] of CANDIDATES) {
  const r = await probe(url);
  const ok = r.isManifest && !r.endlist;
  console.log(
    `${ok ? '★' : ' '} ${name.padEnd(28)} ${String(r.status).padEnd(4)} ` +
      `${ok ? `MANIFEST seq=${r.seq} cors=${r.cors} bytes=${r.bytes}` : (r.error ?? '')}` +
      (r.final && r.final !== url ? `\n     final=${r.final}` : ''),
  );
}
