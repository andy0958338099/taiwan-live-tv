#!/usr/bin/env node
/**
 * 完整建置與測試流程驗證
 *
 * 依序執行：
 *  1. 頻道資料驗證（授權守門）
 *  2. 頻道資料同步
 *  3. 兩端一致性驗證
 *  4. Web 版型別檢查
 *  5. Web 版正式建置
 *  6. Android Debug APK 建置 + 產出檢查
 *
 * 用法：node scripts/run-all-checks.mjs
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const JAVA_HOME = '/Users/andy/.local/toolchains/jdk-17.0.21.1+2/Contents/Home';
const ANDROID_HOME = '/Users/andy/Library/Android/sdk';

const env = {
  ...process.env,
  JAVA_HOME,
  ANDROID_HOME,
  PATH: `${JAVA_HOME}/bin:${ANDROID_HOME}/platform-tools:${process.env.PATH}`,
};

let failures = 0;
const results = [];

function step(name, fn) {
  process.stdout.write(`\n▶ ${name}\n`);
  const start = Date.now();
  try {
    const output = fn();
    const secs = ((Date.now() - start) / 1000).toFixed(1);
    process.stdout.write(output);
    results.push({ name, ok: true, secs });
    console.log(`  ✓ ${name} (${secs}s)`);
  } catch (e) {
    const secs = ((Date.now() - start) / 1000).toFixed(1);
    const msg = (e.stdout || '') + (e.stderr || '') || e.message;
    process.stdout.write(msg.split('\n').slice(-25).join('\n') + '\n');
    results.push({ name, ok: false, secs });
    failures++;
    console.log(`  ✗ ${name} (${secs}s)`);
  }
}

function run(cmd, args, cwd = ROOT) {
  return execFileSync(cmd, args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

console.log('═'.repeat(64));
console.log('台灣電視直播平台 — 完整驗證');
console.log('═'.repeat(64));

// 1. 驗證
step('頻道資料驗證（授權守門）', () => {
  return run(process.execPath, [join(__dirname, 'validate-channels.mjs')]);
});

// 2. 同步
step('頻道資料同步', () => {
  return run(process.execPath, [join(__dirname, 'sync-channels.mjs')]);
});

// 3. 一致性
step('兩端資料一致性', () => {
  return run(process.execPath, [join(__dirname, 'test-channel-consistency.mjs')]);
});

// 4. TypeScript
step('Web 型別檢查', () => {
  return run('npx', ['tsc', '--noEmit'], join(ROOT, 'web'));
});

// 4b. segment 速度估算回歸測試
//
// 這是 2026-11-21 的 P0 守門：代理曾把健康來源誤判成「太慢」而回 502，
// 導致 hls.js 換源、使用者看到「切台」而不是「繼續播放」。
// 測試用真實量測資料（shared/gt-estimator.json）確認沒有誤殺。
step('segment 速度估算回歸測試', () => {
  return run(process.execPath, [join(__dirname, 'test-speed-estimate.mjs')]);
});

// 5. Web 建置
step('Web 正式建置', () => {
  return run('npm', ['run', 'build'], join(ROOT, 'web'));
});

// 6. Android APK
step('Android Debug APK 建置', () => {
  const out = run('./gradlew', ['assembleDebug', '--no-daemon'], join(ROOT, 'android'));
  return out.split('\n').slice(-6).join('\n') + '\n';
});

// 7. 產出檢查
step('產出檔案檢查', () => {
  const apk = join(ROOT, 'android', 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk');
  const webOut = join(ROOT, 'web', '.next');
  const lines = [];

  if (!existsSync(apk)) throw new Error(`APK 不存在: ${apk}`);
  const apkSize = statSync(apk).size / 1024 / 1024;
  lines.push(`  APK: ${(apkSize).toFixed(1)} MB`);

  if (apkSize < 1) throw new Error('APK 檔案過小，可能建置失敗');
  if (apkSize > 100) throw new Error('APK 檔案過大，可能未正確混淆或資源過多');

  if (!existsSync(webOut)) throw new Error(`Web 建置產物不存在: ${webOut}`);
  lines.push(`  Web 產物: ${webOut}`);

  const channelsJson = join(ROOT, 'web', 'public', 'channels.json');
  const data = JSON.parse(readFileSync(channelsJson, 'utf8'));
  lines.push(`  頻道數: ${data.channels.length}`);
  if (data.channels.length === 0) throw new Error('頻道清單為空');

  const bad = data.channels.filter(
    (c) => !['authorized', 'public_official', 'user_provided'].includes(c.authorization_status),
  );
  if (bad.length > 0) {
    throw new Error(`發佈產物含未授權頻道: ${bad.map((c) => c.channel_id).join(', ')}`);
  }
  lines.push('  授權狀態檢查: 全部為可上線值');

  return lines.join('\n') + '\n';
});

console.log('\n' + '═'.repeat(64));
console.log('驗證結果');
console.log('═'.repeat(64));
for (const r of results) {
  console.log(`  ${r.ok ? '✓' : '✗'} ${r.name.padEnd(28)} ${r.secs}s`);
}
console.log('═'.repeat(64));

if (failures > 0) {
  console.log(`\n✗ ${failures} 個步驟失敗`);
  process.exit(1);
}
console.log('\n✓ 全部步驟通過');
