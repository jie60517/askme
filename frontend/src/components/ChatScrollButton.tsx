/**
 * 問答頁訊息區的「捲到底 / New messages」鈕。換掉 `ChatLayout` 預設的那顆,只為了一件事:
 * **使用者自己捲到底時,New messages 要自己收掉**,不用手動點掉。
 *
 * 設計系統的 `useChatNewMessages`(0.4.4,查過 0.7.4 也一樣)只有**按這顆鈕**才會 `dismiss`,
 * 而那個 hook 在 `ChatLayout` 裡面、沒有把手可以從外面收。所以照 `ChatLayout` 的 `scrollButton`
 * 口子換一顆:外觀是同一個 `ChatLayoutScrollButton`,門檻也照抄設計系統的預設
 * (`useChatStreamScroll` 的 buttonThreshold 100、lockThreshold 10),只多了「到底就收」。
 *
 * ⚠️ 黏底(串流時把畫面拉著走)仍然是 `ChatLayout` 自己那一組在做,這裡**不寫 scrollTop**,
 * 只有按下去那一下例外。判斷「使用者往上捲了」的規則跟它一樣(見 `lib/chatJump.ts` 檔頭):
 * 往上捲、而且跟上一個捲動事件之間內容高度沒變,才算;離底 ≤ 10px 的捲動結束算回到底。
 *
 * ⚠️ 捲動容器從**自己的外框往上找**,不要從 Chat.tsx 傳 `ChatLayout` 的 ref 進來:
 * `ChatLayout` 用 `mergeRefs` 每次 render 都換一支新的 callback,父層的 ref 每重繪一次就先清成 null
 * 再接回;effect 若正好在空的那一下跑到,整個鈕就沒接上捲動事件(實機量到的)。
 */
import {useCallback, useEffect, useRef, useState} from 'react';

import {ChatLayoutScrollButton} from '@astryxdesign/core/Chat';
import {useTranslator} from '@astryxdesign/core/i18n';

import {scrollerOf} from '../lib/chatJump';

/** 離底多遠才出現(設計系統 buttonThreshold 的預設) */
const BUTTON_THRESHOLD = 100;
/** 離底多近算「在最底」(設計系統 lockThreshold 的預設,`lib/chatJump.ts` 也用這個值) */
const LOCK_THRESHOLD = 10;

/** 設計系統每一則訊息根節點的 class(`useChatNewMessages` 也是靠它認「多了一則」) */
const MESSAGE_CLASS = 'astryx-chat-message';

const distanceToBottom = (el: HTMLElement) => el.scrollHeight - el.scrollTop - el.offsetHeight;
const sizeOf = (el: HTMLElement) => `${el.scrollHeight}x${el.offsetHeight}`;
function lastMessage(el: HTMLElement): Element | null {
  const all = el.getElementsByClassName(MESSAGE_CLASS);
  return all.length > 0 ? all[all.length - 1] : null;
}

export function ChatScrollButton() {
  const t = useTranslator();
  const [isScrolledUp, setIsScrolledUp] = useState(false);
  const [hasNew, setHasNew] = useState(false);
  /** 訊息區的捲動容器(= `ChatLayout` 的根)。放 state:接上了 effect 才跟著跑 */
  const [scroller, setScroller] = useState<HTMLElement | null>(null);
  const attach = useCallback((node: HTMLElement | null) => setScroller(scrollerOf(node)), []);
  /** 按下去之後的那一段捲動;捲完還沒到底(途中又長高)就再補一下 */
  const jumping = useRef(false);

  useEffect(() => {
    const el = scroller;
    if (!el) return;
    /** 等同設計系統的「鎖住」:在底部跟著走。往上捲才放開 */
    let following = true;
    let lastTop = el.scrollTop;
    let lastSize = sizeOf(el);
    let last = lastMessage(el);

    const onScroll = () => {
      const distance = distanceToBottom(el);
      setIsScrolledUp(distance > BUTTON_THRESHOLD);
      // ← 這一行就是換掉預設鈕的理由
      if (distance <= LOCK_THRESHOLD) setHasNew(false);
      const size = sizeOf(el);
      if (size !== lastSize) {
        // 內容長高 / 視窗變了帶出來的捲動,不是使用者在捲
        lastSize = size;
        lastTop = el.scrollTop;
        return;
      }
      if (el.scrollTop < lastTop && !jumping.current) following = false;
      lastTop = el.scrollTop;
    };
    const onScrollEnd = () => {
      if (distanceToBottom(el) <= LOCK_THRESHOLD) {
        following = true;
        jumping.current = false;
      } else if (jumping.current) {
        // 平滑捲動的終點是出發時算的,途中長高就停在半路
        el.scrollTo({top: el.scrollHeight, behavior: 'instant'});
      }
    };
    // 跟設計系統一樣看內容的高度變化:最後一則換人了、而人不在底部 → 有新訊息
    const observer = new ResizeObserver(() => {
      const now = lastMessage(el);
      if (now && now !== last) {
        last = now;
        if (!following) setHasNew(true);
      }
    });
    for (const child of el.children) observer.observe(child);

    // 按下去之後還在滑,使用者自己動了 → 交還給他,不要在捲動結束時又把他拉回底部
    const takeOver = () => {
      jumping.current = false;
    };

    el.addEventListener('scroll', onScroll, {passive: true});
    el.addEventListener('scrollend', onScrollEnd);
    el.addEventListener('wheel', takeOver, {passive: true});
    el.addEventListener('touchstart', takeOver, {passive: true});
    return () => {
      el.removeEventListener('scroll', onScroll);
      el.removeEventListener('scrollend', onScrollEnd);
      el.removeEventListener('wheel', takeOver);
      el.removeEventListener('touchstart', takeOver);
      observer.disconnect();
    };
  }, [scroller]);

  return (
    <ChatLayoutScrollButton
      ref={attach}
      isVisible={isScrolledUp || hasNew}
      label={hasNew ? t('@astryx.chatLayout.newMessages') : undefined}
      onClick={() => {
        const el = scroller;
        setHasNew(false);
        if (!el) return;
        jumping.current = true;
        el.scrollTo({top: el.scrollHeight, behavior: 'smooth'});
      }}
    />
  );
}
