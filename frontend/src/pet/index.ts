/**
 * 小夥伴元件包的對外入口。
 *
 * 你的專案只需要從這裡 import,不用去記個別檔案的路徑:
 *
 *   import PetCompanion, { configurePetSource, configurePet, petSay } from "@/pet";
 */

export { default as PetCompanion, default } from "./PetCompanion";

export {
  configurePetSource,
  configurePet,
  getPetConfig,
  getPetSource,
  type PetSource,
  type PetTask,
  type PetTool,
  type PetConfig,
} from "./petSource";

export { petSay, PET_SPEAK_EVENT, SPEECH_MS, type PetSpeech } from "./petSpeech";

export {
  PET_SPRITES,
  getSprite,
  isPetHidden,
  setPetHidden,
  isPetPinned,
  unpinPet,
  PET_VISIBILITY_EVENT,
  PET_POSITION_EVENT,
  type PetState,
  type PetSprite,
  // 時間門檻。想調的話從這裡讀比較好對照,不要在別處另抄一份數字。
  POKE_MS,
  ANNOYED_CLICKS,
  ANNOYED_WINDOW_MS,
  SLEEP_AFTER_IDLE_MS,
  GRINDING_AFTER_MS,
  TRANSIENT_MS,
  MIN_STATE_MS,
  AUTO_SPEECH_MS,
  bubbleDropPx,
} from "./pet-sprites";

export { useTooltipWobble, TOOLTIP_PANEL_CLASS, TOOLTIP_ARROW_TOP_CLASS } from "./tooltip-panel";
