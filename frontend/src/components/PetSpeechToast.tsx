/**
 * 吉祥物沒在聽的時候,它要講的話改發 toast。
 *
 * 吉祥物的對白不只是裝飾:@ 提及、有人分享對話給你(`lib/sharedWatch.ts`)、答完那句額度
 * (`lib/petSetup.tsx`)都是 `petSay()` 講的。沒有吉祥物在聽的三種情況,那幾句都要改由這裡發:
 * - Settings 把吉祥物關掉;
 * - **手機**:吉祥物本來就不畫(`App.tsx` 的 `!isMobile`)—— 不發 toast 的話 @ 提及在手機上會直接被吞掉,
 *   因為講完就標成已講過了;
 * - 剛把吉祥物打開、它那一包還在載入。
 * 所以這支一直掛著,每一則只看「現在有沒有吉祥物在聽」(`isPetListening`),不看開關或螢幕寬。
 *
 * 字照原本那句(中文,CLAUDE.md 中文例外第 2 條的小夥伴台詞),有連結的帶一顆 Open(同 `SaveToNotes` 的 toast)。
 */
import {useEffect} from 'react';
import {useNavigate} from 'react-router-dom';

import {isPetListening, PET_SPEAK_EVENT, type PetSpeech} from '../pet/petSpeech';
import {ACTION_HIDE_MS, showNotice} from '../lib/toast';

export function PetSpeechToast() {
  const navigate = useNavigate();
  useEffect(() => {
    const onSpeak = (e: Event) => {
      if (isPetListening()) return;
      const speech = (e as CustomEvent<PetSpeech>).detail;
      if (!speech?.text) return;
      const href = speech.href;
      showNotice({
        text: speech.text,
        kind: 'info',
        ...(href ? {action: {label: 'Open', onClick: () => navigate(href)}, autoHideMs: ACTION_HIDE_MS} : {}),
      });
    };
    window.addEventListener(PET_SPEAK_EVENT, onSpeak);
    return () => window.removeEventListener(PET_SPEAK_EVENT, onSpeak);
  }, [navigate]);
  return null;
}
