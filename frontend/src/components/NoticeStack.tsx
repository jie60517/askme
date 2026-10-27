/**
 * 全站提示的那一疊(視窗右下)。佇列與計時在 `lib/toast.ts`,這裡只負責畫。
 *
 * 跟輸入框旁邊的附件通知**同一套**:同一張 `NoticeCard`、同一組進退場
 * (global.css 的 `[data-notice]` / `[data-leaving]`:從下面浮上來、淡出往上收一點)、
 * 同一個 FLIP(新的一張進來時上面幾張滑上去,不是一格瞬移)。新的在最下面,舊的往上推。
 *
 * ⚠️ 整疊是 `popover="manual"`:進 top layer 才蓋得過對話框(帳號設定、MFA 那幾個
 * 對話框開著的時候也會發提示)。top layer 是「後進的在上面」,所以**有 modal 對話框開著時
 * 要重新 showPopover 一次**排到它上面 —— 兩個時機:對話框打開的那一下(先有提示、後開對話框)、
 * 對話框開著時提示有變(新的一張、或同一個 uniqueID 原地換掉)。
 * 重排是 hide → show,畫面上已經在的卡會被當成新出現、重演進場;重排那一下掛 `data-notice-snap`
 * 把過場關掉(global.css),卡就原地不動。
 */
import {useEffect, useLayoutEffect, useRef, useSyncExternalStore} from 'react';
import * as stylex from '@stylexjs/stylex';

import {Stack, VStack} from '@astryxdesign/core/Layout';

import {
  dismissNotice,
  getNotices,
  pauseNotice,
  resumeNotice,
  setWindowAway,
  subscribeNotices,
} from '../lib/toast';
import {useFlip} from '../lib/useFlip';
import {NoticeCard} from './NoticeCard';

const styles = stylex.create({
  /**
   * 位置跟設計系統的 ToastViewport bottomEnd 一樣(右下、一圈 --spacing-4)。
   * popover 的 UA 樣式(inset: 0、margin: auto、Canvas 底色、框線)全部歸零。
   */
  viewport: {
    position: 'fixed',
    inset: 'auto',
    insetBlockEnd: 0,
    insetInlineEnd: 0,
    margin: 0,
    padding: 'var(--spacing-4)',
    border: 'none',
    backgroundColor: 'transparent',
    overflow: 'visible',
    // 寫死寬度:設計系統沒有「一張卡多寬」的 token。比附件卡(236,擠在輸入框右邊)寬,因為這裡的句子比較長
    width: 300,
    maxWidth: '100vw',
    boxSizing: 'border-box',
    pointerEvents: 'none',
  },
  card: {
    pointerEvents: 'auto',
  },
});

/** 排到 top layer 最上面(只有 modal 對話框開著時才需要,見檔頭) */
function promote(el: HTMLElement) {
  if (typeof el.showPopover !== 'function') return;
  try {
    if (!el.matches(':popover-open')) {
      el.showPopover();
      return;
    }
    if (!document.querySelector('dialog:modal')) return;
    el.setAttribute('data-notice-snap', '');
    el.hidePopover();
    el.showPopover();
    requestAnimationFrame(() => el.removeAttribute('data-notice-snap'));
  } catch {
    // 不支援 popover:留在一般層,只是蓋不過對話框
  }
}

export function NoticeStack() {
  const notices = useSyncExternalStore(subscribeNotices, getNotices, getNotices);
  const flip = useFlip<number>([notices]);
  const ref = useRef<HTMLElement>(null);

  // 提示有變(新的一張 / 原地換掉 / 收掉):對話框開著的話排到它上面
  useLayoutEffect(() => {
    if (ref.current) promote(ref.current);
  }, [notices]);

  // 對話框打開的那一下:先有的提示(例如「有新版本」)不能被它蓋住
  useEffect(() => {
    const observer = new MutationObserver((records) => {
      const opened = records.some((r) => r.target instanceof HTMLDialogElement && r.target.open);
      if (opened && ref.current && getNotices().length > 0) promote(ref.current);
    });
    observer.observe(document.body, {subtree: true, attributes: true, attributeFilter: ['open']});
    return () => observer.disconnect();
  }, []);

  // 視窗切到別的地方時倒數暫停(設計系統 Toast 原本的行為)
  useEffect(() => {
    const away = () => setWindowAway(true);
    const back = () => setWindowAway(false);
    window.addEventListener('blur', away);
    window.addEventListener('focus', back);
    return () => {
      window.removeEventListener('blur', away);
      window.removeEventListener('focus', back);
    };
  }, []);

  return (
    <VStack
      ref={ref}
      gap={2}
      xstyle={styles.viewport}
      {...{popover: 'manual'}}
      // 每張卡自己是 status / alert(live region);外層只是一個有名字的區塊,不再包一層 live
      role="region"
      aria-label="Notifications"
    >
      {notices.map((n) => (
        // 外層 FLIP、裡層進退場(跟 Chat.tsx 的附件疊同一個分層理由)
        <Stack key={n.id} ref={flip(n.id)}>
          <Stack
            xstyle={styles.card}
            {...{'data-notice': '', 'data-leaving': n.isLeaving ? '' : undefined}}
            role={n.kind === 'error' ? 'alert' : 'status'}
            onMouseEnter={() => pauseNotice(n.id)}
            onMouseLeave={() => resumeNotice(n.id)}
            onFocus={() => pauseNotice(n.id)}
            onBlur={() => resumeNotice(n.id)}
          >
            <NoticeCard
              kind={n.kind}
              text={n.text}
              action={n.action}
              onClose={n.isPersistent ? () => dismissNotice(n.id) : undefined}
            />
          </Stack>
        </Stack>
      ))}
    </VStack>
  );
}
