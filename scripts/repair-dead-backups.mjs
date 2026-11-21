#!/usr/bin/env node
/**
 * repair-dead-backups.mjs — 移除指向「已死 host」的備援來源
 *
 * ## 為什麼需要這個
 *
 * 深度探測（verify-channel-sources.mjs）顯示 80/80 頻道可播，
 * 但有 9 個頻道的主來源已經壞掉，只能靠備援撐住。
 * 進一步比對發現：**備援清單裡有 81 個網址指向 4 個已經完全死亡的 host**
 * （101.66.194.88 / 101.66.199.181 / 101.66.199.96 / 101.66.194.29）。
 *
 * 這 4 個 host 不是「偶發壅塞」而是**整台死掉** ——
 * 實測 87 組 (host, path) 全部無法建立連線，
 * 而且 `playlive=0` 與 `playlive=1` 參數都一樣死（所以不是參數問題）。
 *
 * ## 危害
 *
 * 1. **failover 會先撞到死 host。**
 *    12 個頻道的第一順位備援就是死 host ——
 *    這表示主來源一壞，播放器先花 ~11 秒（proxy 連線逾時）才換到第二順位。
 *    使用者看到的是「轉圈圈 11 秒」，而不是立刻換源。
 *
 * 2. **憑空多出 81 次無謂的逾時等待。**
 *
 * 3. **主來源被佔用。**
 *    4 個頻道（cn-cctv2 / cn-cctv12 / cn-cctv15 / cn-gx / cn-sx / cn-sx2）的
 *    主來源本身就在死 host 上 —— 這些頻道每���都必須先等逾時才能 failover。
 *
 * ## 做法
 *
 * 1. 探測所有不重複的 (host, path) 組合，判斷 host 是否整台死掉
 *    （同一 host 的多個 path 全部失敗才算死，避免誤殺單一 path 的問題）
 * 2. 把清單中指向死 host 的備援網址移除
 * 3. 若頻道的主來源也在死 host 上，則改用「同 path 的其他 host」作為主來源
 *    （同 path 代表同一個頻道在不同機房的鏡像）
 * 4. 重新排序備援：把探測實測可用且最快的排在前面
 *
 * ## 用法
 *
 *   node scripts/repair-dead-backups.mjs --dry-run
 *   node scripts/repair-dead-backups.mjs
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const CHANNELS_PATH = join(ROOT, 'shared', 'channels.json');

const DRY_RUN = process.argv.includes('--dry-run');
const CONC = parseInt(
  (() => {
    const i = process.argv.indexOf('--conc');
    return i >= 0 ? process.argv[i + 1] : '16';
  })(),
  10,
);

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36';

function arg(name, dflt) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : dflt;
}
const TIMEOUT_MS = parseInt(arg('timeout', '8000'), 10);

/**
 * 探測一個 manifest 是否可讀。
 *
 * ⚠️ **必須用清單裡的原始網址**，不能改動 query 參數 ——
 * 不同來源的 query 語意完全不同：
 *   · itvlist 系列   `?key=txiptv&playlive=1&authid=0`（key 是必要參數）
 *   · live.php 系列  `?id=深圳卫视`（追加任何參數都會破壞它）
 *   · Akamai 系列    網址本身帶 token（過期就是過期，不能靠改參數救）
 * 亂加參數會把好端端的來源誤判成死亡。
 *
 * 只看 manifest、不抓 segment —— 快，且足以判斷 host 是否整台死掉。
 */
async function manifestOk(url) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': UA },
        signal: ac.signal,
      });
      if (!res.ok) return { ok: false, why: `HTTP ${res.status}` };
      const text = await res.text();
      if (!text.trimStart().startsWith('#EXTM3U')) return { ok: false, why: '非 m3u8' };
      return { ok: true };
    } catch (e) {
      // 逾時／連線錯誤 → 重試一次（上游偶發壅塞不代表死亡）
      if (attempt === 0) {
        await new Promise((r) => setTimeout(r, 1200));
        continue;
      }
      return { ok: false, why: e.name };
    } finally {
      clearTimeout(t);
    }
  }
  return { ok: false, why: '未知' };
}

async function main() {
  console.log('═'.repeat(70));
  console.log('移除指向死 host 的備援來源');
  console.log('═'.repeat(70));

  const catalog = JSON.parse(readFileSync(CHANNELS_PATH, 'utf8'));

  // ── 1. 收集所有不重複的 (host, path) ──
  const combos = new Map(); // key → { host, path, urls[] }
  const addUrl = (u) => {
    if (!u) return;
    try {
      const url = new URL(u);
      const key = `${url.host}${url.pathname}`;
      if (!combos.has(key)) combos.set(key, { host: url.host, path: url.pathname, urls: [] });
      combos.get(key).urls.push(u);
    } catch {
      /* ignore */
    }
  };
  for (const c of catalog.channels) {
    addUrl(c.stream_url);
    for (const b of c.playlist_source?.backup_urls ?? []) addUrl(b.url);
  }

  console.log(`探測 ${combos.size} 組 (host, path)…`);

  // ── 2. 並行探測 ──
  const results = [];
  const list = [...combos.values()];
  let idx = 0;
  async function worker() {
    while (idx < list.length) {
      const combo = list[idx++];
      const r = await manifestOk(combo.urls[0]);
      results.push({ ...combo, ...r });
    }
  }
  await Promise.all(Array.from({ length: CONC }, worker));

  // ── 3. 判定「整台死掉」的 host ──
  //     同一 host 的**所有** path 都失敗 → 判定 host 死亡。
  //
  //     ⚠️ 只有 1 個 path 的 host 不能用這個判準 ——
  //     單一 path 失敗可能只是那個 path 壞了（Akamai token 過期之類），
  //     不足以判定整台主機死亡。
  const byHost = new Map();
  for (const r of results) {
    if (!byHost.has(r.host)) byHost.set(r.host, []);
    byHost.get(r.host).push(r);
  }
  const deadHosts = new Set();
  for (const [host, rs] of byHost) {
    // 至少要有 2 個不同 path 都失敗才判定死亡
    if (rs.length >= 2 && rs.every((r) => !r.ok)) deadHosts.add(host);
  }

  console.log('');
  console.log('完全死亡的 host：');
  for (const h of deadHosts) {
    const paths = byHost.get(h).length;
    console.log(`  ✗ ${h}  （${paths} 個 path 全部無法連線）`);
  }
  if (!deadHosts.size) console.log('  （無）');

  // ── 4. 找出每個 dead host 的替代 host（同 path 的鏡像）──
  /** path → 可用的 host 清單 */
  const liveByPath = new Map();
  for (const r of results) {
    if (r.ok) {
      if (!liveByPath.has(r.path)) liveByPath.set(r.path, new Set());
      liveByPath.get(r.path).add(r.host);
    }
  }

  /** 某個 host 上的某個 path，有沒有活著的鏡像 */
  function liveMirror(path) {
    const hosts = liveByPath.get(path);
    if (!hosts) return null;
    const arr = [...hosts];
    return arr.length ? arr[0] : null;
  }

  // ── 5. 套用修改 ──
  let removedBackups = 0;
  let fixedPrimaries = 0;
  const details = [];

  for (const c of catalog.channels) {
    const backups = c.playlist_source?.backup_urls ?? [];
    if (!backups.length) continue;

    // 5a. 主來源在死 host 上 → 換成同 path 的活鏡像
    if (c.stream_url) {
      let u;
      try {
        u = new URL(c.stream_url);
      } catch {
        u = null;
      }
      if (u && deadHosts.has(u.host)) {
        const mirror = liveMirror(u.pathname);
        if (mirror) {
          const old = c.stream_url;
          // 只換 host，保留原本的 query（key / playlive / authid 都有語意）
          const nu = new URL(old);
          nu.host = mirror;
          c.stream_url = nu.toString();
          fixedPrimaries++;
          details.push(
            `  ↻ ${c.channel_name} 主來源 host 已死\n      舊: ${old}\n      新: ${c.stream_url}`,
          );
          // 舊主來源若不是死 host，就保留為備援（它可能只是暫時的問題）
          const oldIsDead = deadHosts.has(u.host);
          if (!oldIsDead) {
            c.playlist_source.backup_urls.unshift({ url: old, source: '原主來源', cors: false });
          }
        }
      }
    }

    // 5b. 移除指向死 host 的備援
    const before = backups.length;
    const kept = backups.filter((b) => {
      if (!b.url) return false;
      try {
        return !deadHosts.has(new URL(b.url).host);
      } catch {
        return true;
      }
    });
    removedBackups += before - kept.length;
    if (kept.length !== before) {
      for (const b of backups) {
        if (!kept.includes(b)) {
          details.push(
            `  ✗ ${c.channel_name} 移除死 host 備援: ${b.url}`,
          );
        }
      }
    }
    c.playlist_source.backup_urls = kept;
  }

  console.log('');
  console.log(details.join('\n'));
  console.log('');
  console.log(
    `置換主來源 ${fixedPrimaries} 個｜移除死 host 備援 ${removedBackups} 個`,
  );

  const totalBackups = catalog.channels.reduce(
    (n, c) => n + (c.playlist_source?.backup_urls?.length ?? 0),
    0,
  );
  console.log(`剩餘備援總數：${totalBackups}`);

  if (DRY_RUN) {
    console.log('\n(dry-run 模式，未寫入檔案)');
    return;
  }

  catalog.updated_at = new Date().toISOString();
  writeFileSync(CHANNELS_PATH, JSON.stringify(catalog, null, 2) + '\n', 'utf8');
  console.log(`\n已寫入 ${CHANNELS_PATH}`);
}

main();
