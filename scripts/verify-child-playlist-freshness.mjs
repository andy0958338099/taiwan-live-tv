#!/usr/bin/env node
/**
 * verify-child-playlist-freshness.mjs
 *
 * 量測「經過代理的**子** media playlist」是否真的會更新序號。
 *
 * ## 為什麼要測「子」playlist
 *
 * 代理改寫 manifest 時會把 master 裡的子清單網址換成帶簽章的代理網址。
 * hls.js 實際輪詢的是**子** media playlist（那一份才有 `#EXT-X-MEDIA-SEQUENCE`）。
 *
 * master manifest 本身通常不會變（畫質階級固定），所以
 * 「master 內容不變」是正常的；**子 playlist 的序號不變才是不正常**。
 *
 * ## 判定
 *
 *   · 子 playlist 的 MEDIA-SEQUENCE 前進 → 代理沒有冰住 live 清單 ✅
 *   · 子 playlist 一直不變，但直連上游會變 → **代理層的問題** ❌
 *   · 子 playlist 一直不變，直連上游也不變 → 來源本身停播（不是代理的問題）ℹ️
 *
 * 用法：node scripts/verify-child-playlist-freshness.mjs [--base https://...] [--rounds 6] [--interval 5]
 */
import { createHash } from 'node:crypto';

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : dflt;
};

const BASE = arg('base', 'https://taiwan-live-tv.netlify.app');
const ROUNDS = Number(arg('rounds', '6'));
const INTERVAL_MS = Number(arg('interval', '5')) * 1000;

const DEFAULT_IDS = [
  'playlist-龍華-龍華電視',
  'playlist-Now-now-tv',
  'tw-goodtv-ch1',
  'iptvorg-dalitv-tw-sd',
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parse(text) {
  const seq = text.match(/^#EXT-X-MEDIA-SEQUENCE:(\d+)/m);
  const td = text.match(/^#EXT-X-TARGETDURATION:(\d+(?:\.\d+)?)/m);
  const segs = text.split(/\r?\n/).filter((l) => l.trim() && !l.trim().startsWith('#')).length;
  return {
    seq: seq ? Number(seq[1]) : null,
    td: td ? Number(td[1]) : null,
    segs,
    sha: createHash('sha256').update(text).digest('hex').slice(0, 10),
  };
}

/** 從 master manifest 找出第一個子清單網址（已經被代理改寫成帶 sig 的網址） */
function childUrlFrom(text, base) {
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].startsWith('#EXT-X-STREAM-INF')) {
      for (let j = i + 1; j < lines.length; j += 1) {
        if (lines[j] && !lines[j].startsWith('#')) {
          return new URL(lines[j], base).toString();
        }
      }
    }
  }
  return null;
}

async function main() {
  console.log('═'.repeat(78));
  console.log('驗證：代理的子 media playlist 是否會更新序號');
  console.log('═'.repeat(78));
  console.log(`測試站點：${BASE}　輪數：${ROUNDS}　間隔：${INTERVAL_MS / 1000}s\n`);

  const cat = await (await fetch(`${BASE}/channels.json`)).json();
  const channels = cat.channels;
  const ids = arg('ids', '').split(',').filter(Boolean);
  const targets = ids.length ? ids : DEFAULT_IDS;

  const summary = [];

  for (const id of targets) {
    const ch = channels.find((c) => c.channel_id === id);
    if (!ch) {
      console.log(`? ${id} —— 頻道不存在`);
      continue;
    }
    const enc = Buffer.from(ch.stream_url, 'utf8').toString('base64url');
    const masterUrl = `${BASE}/api/proxy/${enc}`;

    console.log(`── ${ch.channel_name} (${id})`);

    // 取 master → 找子清單
    const mres = await fetch(masterUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 Chrome/131.0 Safari/537.36' },
    });
    const mtext = await mres.text();
    let child = childUrlFrom(mtext, BASE);

    if (!child) {
      // 本來就是 media playlist（沒有 master）
      const p = parse(mtext);
      console.log(`   （來源直接是 media playlist）seq=${p.seq} td=${p.td} segs=${p.segs}`);
      child = masterUrl;
    } else {
      console.log(`   子清單網址：${child.slice(0, 88)}…`);
    }

    const samples = [];
    for (let i = 0; i < ROUNDS; i += 1) {
      const res = await fetch(child, {
        headers: { 'User-Agent': 'Mozilla/5.0 Chrome/131.0 Safari/537.36' },
      });
      const text = await res.text();
      const p = parse(text);
      samples.push({ ...p, age: res.headers.get('age'), status: res.status });
      console.log(
        `   [${i + 1}/${ROUNDS}] seq=${p.seq ?? '—'} td=${p.td ?? '—'} segs=${p.segs} ` +
          `sha=${p.sha} age=${res.headers.get('age') ?? '—'} status=${res.status}`,
      );
      if (i < ROUNDS - 1) await sleep(INTERVAL_MS);
    }

    const seqs = samples.map((s) => s.seq).filter((s) => s !== null);
    const unique = new Set(seqs);
    const advanced = unique.size > 1;

    // 對照組：直連上游的子清單
    let upstreamAdvanced = null;
    try {
      const um = await fetch(ch.stream_url, {
        headers: {
          Referer: 'https://taiwan-live-tv.netlify.app/',
          'User-Agent': 'Mozilla/5.0 Chrome/131.0 Safari/537.36',
        },
      });
      const umtext = await um.text();
      const directChild = childUrlFrom(umtext, ch.stream_url);
      const directUrl = directChild ?? ch.stream_url;
      const dres = await fetch(directUrl, {
        headers: {
          Referer: 'https://taiwan-live-tv.netlify.app/',
          'User-Agent': 'Mozilla/5.0 Chrome/131.0 Safari/537.36',
        },
      });
      const dtext = await dres.text();
      const dp = parse(dtext);
      // 再等一輪比對
      await sleep(INTERVAL_MS);
      const dres2 = await fetch(directUrl, {
        headers: {
          Referer: 'https://taiwan-live-tv.netlify.app/',
          'User-Agent': 'Mozilla/5.0 Chrome/131.0 Safari/537.36',
        },
      });
      const dp2 = parse(await dres2.text());
      upstreamAdvanced =
        dp.seq !== null && dp2.seq !== null ? dp2.seq !== dp.seq : null;
      console.log(
        `   直連上游對照：seq ${dp.seq} → ${dp2.seq}（${upstreamAdvanced ? '會變' : '不變'}）`,
      );
    } catch (e) {
      console.log(`   直連上游對照失敗：${String(e?.message ?? e)}`);
    }

    let verdict;
    if (advanced) {
      verdict = '✅ 子 playlist 序號有前進（代理沒有冰住 live 清單）';
    } else if (upstreamAdvanced === false) {
      verdict = 'ℹ️ 代理與上游都不變 → 來源本身停播，不是代理的問題';
    } else if (upstreamAdvanced === true) {
      verdict = '❌ 上游會變但代理不變 → 代理層把 live 清單冰住了';
    } else {
      verdict = '⚠️ 序號未前進，上游對照無法判定';
    }
    console.log(`   判定：${verdict}\n`);
    summary.push({ name: ch.channel_name, verdict });
  }

  console.log('═'.repeat(78));
  console.log('總結');
  console.log('═'.repeat(78));
  for (const s of summary) console.log(`${s.verdict.startsWith('✅') ? '✓' : '!'} ${s.name.padEnd(16)} ${s.verdict}`);
  const bad = summary.filter((s) => s.verdict.startsWith('❌'));
  console.log('');
  console.log(bad.length === 0 ? '結果：✓ 代理沒有冰住任何 live 清單' : `結果：✗ ${bad.length} 個頻道的 live 清單被冰住`);
  process.exit(bad.length === 0 ? 0 : 1);
}

main();
