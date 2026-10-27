/**
 * 登入頁右側那塊的互動場景。
 *
 * 每一款都是一個工廠函式:拿到 renderer 與尺寸,回傳 update / resize / dispose。
 * 顏色一律由外面用 Astryx 的 token 解析好餵進來 —— 場景裡不准出現色碼,
 * 不然換佈景或深色模式時這塊會是唯一對不上的地方。
 */
import type * as THREE from 'three';

export type ScenePalette = {
  /** 主角色(品牌色) */
  accent: THREE.ColorRepresentation;
  /** 底色 */
  background: THREE.ColorRepresentation;
  /** 次要/線條 */
  muted: THREE.ColorRepresentation;
};

export type SceneContext = {
  renderer: THREE.WebGLRenderer;
  width: number;
  height: number;
  palette: ScenePalette;
  /** 使用者要求減少動態時為 true:畫一張靜態的就好,不要持續動 */
  reducedMotion: boolean;
};

export type SceneHandle = {
  /** 每一格呼叫一次。pointer 是 -1..1 的正規化座標,沒有指標時是 (0,0) */
  update: (elapsed: number, pointer: {x: number; y: number}) => void;
  resize: (width: number, height: number) => void;
  dispose: () => void;
};

export type SceneFactory = {
  name: string;
  create: (ctx: SceneContext) => SceneHandle;
};
