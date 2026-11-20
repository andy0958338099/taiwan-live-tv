/**
 * /privacy — 來源揭露與授權說明
 *
 * 為什麼需要這個頁面：
 *   1. `netlify.toml` 已經為 `/privacy` 設定了「不可快取」的 header 規則
 *   2. 專案規範要求「每個頻道都必須標註來源及授權狀態」
 *   3. 站台上的頻道有兩種性質完全不同的來源：
 *      官方嵌入（public_official）與第三方轉載（user_provided），
 *      使用者有權利知道自己在看的是哪一種
 *
 * 這個頁面是**靜態生成**的：資料在建置時從 shared/channels.json 讀入，
 * 因此不會每次請求都打檔案系統（serverless 環境不可靠）。
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import styles from './privacy.module.css';

interface Catalog {
  updated_at: string;
  channels: {
    channel_id: string;
    channel_name: string;
    source_name: string;
    source_website: string;
    authorization_status: string;
    region?: string | null;
  }[];
}

/** 建置時讀取頻道資料 */
function loadCatalog(): Catalog {
  const path = join(process.cwd(), '..', 'shared', 'channels.json');
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Catalog;
  } catch {
    return { updated_at: '', channels: [] };
  }
}

const AUTH_LABEL: Record<string, { text: string; tone: string; note: string }> = {
  public_official: {
    text: '官方公開播放器',
    tone: 'official',
    note: '官方頁面本身即以 iframe 內嵌該播放器，未設防嵌入限制，等同官方默許嵌入。本站只嵌入官方播放器網址，不轉接其串流。',
  },
  authorized: {
    text: '已取得授權',
    tone: 'official',
    note: '頻道業者明確授權嵌入或重新發佈。',
  },
  user_provided: {
    text: '使用者提供的 IPTV 清單',
    tone: 'provided',
    note: '來源為第三方彙整的轉載清單，由使用者提供並指定使用。清單提供者是否取得原始頻道業者的授權，本專案無法查證。請確認你對其使用方式有權利基礎。',
  },
};

export default function PrivacyPage() {
  const catalog = loadCatalog();

  const groups = new Map<string, Catalog['channels']>();
  for (const ch of catalog.channels) {
    const key =
      ch.authorization_status === 'public_official'
        ? 'public_official'
        : 'user_provided';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(ch);
  }

  // 依來源網站彙整轉載清單
  const providers = new Map<string, number>();
  for (const ch of catalog.channels) {
    if (!ch.source_website) continue;
    providers.set(ch.source_website, (providers.get(ch.source_website) ?? 0) + 1);
  }

  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <h1 className={styles.title}>來源揭露與授權說明</h1>
        <p className={styles.subtitle}>
          台灣電視直播平台 — Taiwan Live TV
        </p>
      </header>

      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>頻道來源總覽</h2>
        <div className={styles.statGrid}>
          <div className={styles.statCard}>
            <span className={styles.statValue}>{catalog.channels.length}</span>
            <span className={styles.statLabel}>頻道總數</span>
          </div>
          {(groups.get('public_official')?.length ?? 0) > 0 && (
            <div className={styles.statCard}>
              <span className={styles.statValue}>
                {groups.get('public_official')!.length}
              </span>
              <span className={styles.statLabel}>官方公開播放器</span>
            </div>
          )}
          {(groups.get('user_provided')?.length ?? 0) > 0 && (
            <div className={styles.statCard}>
              <span className={styles.statValue}>
                {groups.get('user_provided')!.length}
              </span>
              <span className={styles.statLabel}>使用者提供的清單</span>
            </div>
          )}
        </div>
        {catalog.updated_at && (
          <p className={styles.updatedAt}>
            資料更新於 {new Date(catalog.updated_at).toLocaleString('zh-TW')}
          </p>
        )}
      </section>

      {(['public_official', 'user_provided'] as const).map((status) => {
        const list = groups.get(status);
        if (!list?.length) return null;
        const meta = AUTH_LABEL[status];
        return (
          <section key={status} className={styles.section}>
            <h2 className={styles.sectionTitle}>
              <span className={`${styles.badge} ${styles[meta.tone]}`}>
                {meta.text}
              </span>
            </h2>
            <p className={styles.note}>{meta.note}</p>
            <ul className={styles.channelList}>
              {list.map((ch) => (
                <li key={ch.channel_id} className={styles.channelItem}>
                  <span className={styles.channelName}>{ch.channel_name}</span>
                  <span className={styles.channelSource}>{ch.source_name}</span>
                  {ch.source_website && (
                    <a
                      className={styles.channelLink}
                      href={ch.source_website}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      來源網站
                    </a>
                  )}
                </li>
              ))}
            </ul>
          </section>
        );
      })}

      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>轉載清單一覽</h2>
        <p className={styles.note}>
          以下是本站使用的 IPTV 播放清單。這些清單由使用者提供，
          是第三方彙整的轉載來源，非頻道業者的官方授權串流。
        </p>
        <ul className={styles.providerList}>
          {[...providers.entries()]
            .sort((a, b) => b[1] - a[1])
            .map(([url, count]) => (
              <li key={url} className={styles.providerItem}>
                <a href={url} target="_blank" rel="noopener noreferrer">
                  {url}
                </a>
                <span className={styles.providerCount}>{count} 個頻道</span>
              </li>
            ))}
        </ul>
      </section>

      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>本專案不做的事</h2>
        <ul className={styles.policyList}>
          <li>不破解付費電視頻道</li>
          <li>不繞過任何 DRM（WideWidevine / FairPlay / PlayReady）</li>
          <li>不未經授權擷取付費電視訊號</li>
          <li>不偽造或猜測串流網址 — 每個網址都經過實際連線驗證</li>
          <li>不繞過網站登入、付費或存取限制</li>
          <li>
            不將不允許重新播放的官方網站影片轉接成自己的直播服務
          </li>
        </ul>
        <p className={styles.note}>
          網頁版的 CORS 代理只解決瀏覽器的同源政策限制，
          <strong>不會改變來源的授權狀態</strong>。
          代理僅允許轉送已核准頻道清單中的網址，不是開放代理。
        </p>
      </section>

      <footer className={styles.footer}>
        <p>
          本頁內容由 <code>shared/channels.json</code> 於建置時自動產生，
          與 Android TV APK 讀取的是同一份資料。
        </p>
      </footer>
    </main>
  );
}
