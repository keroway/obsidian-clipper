/*
 * Chrome 用ブックマークレット（読みやすい形）
 *
 * 使い方:
 *   1. WORKER_URL と SECRET を自分の値に書き換える
 *   2. 全文をコピーして https://chriszarate.github.io/bookmarklet/ などで minify
 *   3. 出来上がった "javascript:..." 文字列をブックマークの URL に登録
 *
 * 動作:
 *   現在ページの URL / タイトル / 選択範囲を Worker に POST する。
 *   成功すると右下に通知を出して 2 秒で消える。
 */
(() => {
  const WORKER_URL = 'https://obsidian-clipper.<your-subdomain>.workers.dev/clip';
  const SECRET = 'REPLACE_WITH_SHARED_SECRET';

  const sel = String(window.getSelection() || '');
  const payload = {
    url: location.href,
    title: document.title,
    selection: sel || undefined,
  };

  // 軽量トースト
  const toast = (msg, ok) => {
    const el = document.createElement('div');
    el.textContent = msg;
    Object.assign(el.style, {
      position: 'fixed', right: '16px', bottom: '16px', zIndex: 2147483647,
      padding: '10px 14px', borderRadius: '8px', fontSize: '14px',
      color: '#fff', background: ok ? '#16a34a' : '#dc2626',
      boxShadow: '0 4px 12px rgba(0,0,0,.2)', fontFamily: 'system-ui, sans-serif',
    });
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 2200);
  };

  fetch(WORKER_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + SECRET,
    },
    body: JSON.stringify(payload),
  })
    .then((r) => r.json().then((j) => ({ ok: r.ok, j })))
    .then(({ ok, j }) => toast(ok ? 'Saved: ' + (j.path || '') : 'Error: ' + JSON.stringify(j), ok))
    .catch((e) => toast('Network error: ' + e.message, false));
})();
