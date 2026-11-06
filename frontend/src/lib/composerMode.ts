/**
 * 輸入框底列「專案」那一格在模式裡長什麼樣,以及這一題送哪個環境(這裡只有一般模式)。
 * 畫面那一格是 `pages/Chat.tsx` 包著 `components/ComposerSlot.tsx`;這支只算「要放什麼」,好測。
 *
 * - 一般模式 `/general`:Token「一般模式」(帶 ✕ = 離開),專案選單拿掉,送保留代號 `general`(這一題不帶任何專案)。
 * - 不在模式裡:專案選單照舊,送輸入框選的專案。
 */
import {GENERAL_KB_ID} from './generalMode';

export type ComposerMode = {
  /** 換了才演過場(`ComposerSlot` 的 slotKey) */
  key: string;
  /** Token 上的字;null = 不在模式裡 */
  token: string | null;
  showProject: boolean;
  /** 這一題送哪個環境 */
  kb: string | undefined;
};

export function composerMode({
  generalActive,
  projectKb,
}: {
  generalActive: boolean;
  projectKb: string | undefined;
}): ComposerMode {
  if (generalActive) {
    return {key: 'general', token: '一般模式', showProject: false, kb: GENERAL_KB_ID};
  }
  return {key: 'project', token: null, showProject: true, kb: projectKb};
}
