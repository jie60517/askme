import type { PetState } from "./pet-sprites";

/**
 * 讓小夥伴說一句話。
 *
 * 小夥伴本來只有「狀態」(在讀資料、在搜尋、剛完成),那些是**它自己在做什麼**;
 * 這裡加的是「它要告訴你什麼」—— 例如有人把東西分享給你,那種跟你當下這一頁
 * 無關的事。
 *
 * 為什麼不用 toast:toast 會跟「送出失敗」那類系統訊息混在一起,而這是
 * **別人找你**、不是系統出事。混在同一個通道裡,重要的那則會被當成雜訊滑過去。
 *
 * 用法(任何地方都能呼叫,不需要 React context):
 *
 *   import { petSay } from "…/pet";
 *   petSay({ text: "阿華 @你:這段你熟", state: "happy", href: "/c/abc" });
 */
export const PET_SPEAK_EVENT = "pet:speak";

/** 氣泡停留多久。一句短話讀完大約 2 秒,留 6 秒讓人抬頭時還看得到。 */
export const SPEECH_MS = 6000;

export interface PetSpeech {
  text: string;
  /** 順便切換的表情。不給就維持目前的狀態。 */
  state?: PetState;
  /** 點氣泡要去哪。給了才會變成可以點的。 */
  href?: string;
}

export function petSay(speech: PetSpeech) {
  window.dispatchEvent(new CustomEvent<PetSpeech>(PET_SPEAK_EVENT, { detail: speech }));
}
