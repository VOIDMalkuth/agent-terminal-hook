import { useState, type RefObject } from 'react';
import { useSettings } from '../store/settings';
import { useUi } from '../store/ui';
import { playBeep } from '../lib/sound';
import { cx } from '../lib/cx';

export function SettingsPanel({ panelRef }: { panelRef: RefObject<HTMLDivElement | null> }) {
  const s = useSettings();
  const gateway = useUi((st) => st.gateway);
  const token = useUi((st) => st.token);
  const setSettingsOpen = useUi((st) => st.setSettingsOpen);
  const [copied, setCopied] = useState(false);

  const tokenPath = '%APPDATA%\\com.ath.hud\\token（写死后永不轮换）';

  const copyToken = () => {
    if (!token || copied) return;
    navigator.clipboard
      .writeText(token)
      .then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => {});
  };

  return (
    <div className="settings" ref={panelRef} role="dialog" aria-label="设置">
      <div className="settings-head">
        <span>设置</span>
        <button className="icon-btn" title="关闭" onClick={() => setSettingsOpen(false)}>
          ✕
        </button>
      </div>

      <label className="row">
        <span>背景透明度：{Math.round(s.opacity * 100)}%</span>
        <input
          type="range"
          min={0.35}
          max={1}
          step={0.01}
          value={s.opacity}
          onChange={(e) => s.patch({ opacity: Number(e.target.value) })}
        />
      </label>

      <label className="row">
        <span>内容条透明度：{Math.round(s.cardOpacity * 100)}%</span>
        <input
          type="range"
          min={0.35}
          max={1}
          step={0.01}
          value={s.cardOpacity}
          onChange={(e) => s.patch({ cardOpacity: Number(e.target.value) })}
        />
      </label>

      <label className="check">
        <input
          type="checkbox"
          checked={s.alwaysOnTop}
          onChange={(e) => s.patch({ alwaysOnTop: e.target.checked })}
        />
        始终置顶
      </label>

      <label className="check">
        <input
          type="checkbox"
          checked={s.theme === 'light'}
          onChange={(e) => s.patch({ theme: e.target.checked ? 'light' : 'dark' })}
        />
        日间主题
      </label>

      <label className="check">
        <input
          type="checkbox"
          checked={s.soundOnWaiting}
          onChange={(e) => s.patch({ soundOnWaiting: e.target.checked })}
        />
        waiting_input 提示音
        <button
          className="btn tiny"
          onClick={(e) => {
            e.preventDefault();
            playBeep();
          }}
        >
          试听
        </button>
      </label>

      <label className="check">
        <input
          type="checkbox"
          checked={s.staleOn}
          onChange={(e) => s.patch({ staleOn: e.target.checked })}
        />
        stale 角标（1h 无消息）
      </label>

      <div className="gateway-box">
        <span className={cx('lamp', gateway?.bound && 'ok')} />
        <span className="dim gateway-text">
          {gateway?.bound
            ? `127.0.0.1:${gateway.port} 监听中`
            : `未监听：${gateway?.error ?? '等待后端…'}`}
        </span>
        <button className="btn tiny" onClick={copyToken} disabled={!token} title={tokenPath}>
          {copied ? '已复制' : '复制 Token'}
        </button>
      </div>
    </div>
  );
}
