/**
 * 每一款場景都要的那幾行。
 *
 * 每個場景都要:建 Scene、把底色塗上去、開一台 PerspectiveCamera(0.1 / 100)、
 * resize 時改 aspect + updateProjectionMatrix、dispose 時把 geometry/material 一個一個回收。
 * 集中在這裡,改 near/far 才不會只有部分場景跟到,也不會漏掉某個 dispose 造成洩漏。
 *
 * 各場景自己的數學(波形、頻譜、粒子)完全不碰 —— 這裡只收「每次都一樣」的部分。
 */
import * as THREE from 'three';

import type {SceneContext} from './types';

/** 有 dispose() 的東西:geometry、material、InstancedMesh、render target… */
type Disposable = {dispose: () => void};

export type SceneBase = {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  /** 每一格結尾畫一次 */
  render: () => void;
  /** 直接當成 SceneHandle.resize 用 */
  resize: (width: number, height: number) => void;
  /**
   * 登記一個要回收的資源,原樣回傳 —— 可以直接包在建構式外面:
   * `const geo = base.track(new THREE.BoxGeometry(...))`
   */
  track: <T extends Disposable>(resource: T) => T;
  /** 登記過的東西全部回收。直接當成 SceneHandle.dispose 用。 */
  dispose: () => void;
};

type Options = {
  /** 視角。不給就是 45(大部分場景用的值) */
  fov?: number;
  /** 鏡頭位置 */
  position: [number, number, number];
  /** 要不要看向原點。預設看 */
  lookAtOrigin?: boolean;
};

/**
 * 按住移動超過這麼多 px 就算在拖,不是在點。
 * 場景之間要共用同一個門檻 —— 兩邊各寫一份的話,遲早會變成
 * 「這個場景算點擊、那個場景不算」這種說不清楚的差別。
 */
export const CLICK_SLOP_PX = 4;

/** 使用者點下去激起的一道波 */
export type ClickWave = {
  /** 正規化座標(-1..1),各場景自己換算成世界座標 */
  x: number;
  y: number;
  /** 這道波是幾秒的時候激起來的 */
  startedAt: number;
};

/**
 * 「點一下,從那裡擴散出一圈」。
 *
 * 波的**形狀**由各場景自己決定(水面是同心圓、頻譜是往兩側跑),
 * 這裡只管三件每個場景都一樣的事:接點擊、記位置、把過期的丟掉。
 *
 * 拖曳不算點擊(超過 CLICK_SLOP_PX 就當他在轉畫面),
 * 而且只認主鍵 —— 右鍵是給瀏覽器選單的。
 */
export function createClickWaves(
  {renderer}: SceneContext,
  {life, max = 6}: {life: number; max?: number},
) {
  const dom = renderer.domElement;
  const pending: Array<{x: number; y: number}> = [];
  const waves: ClickWave[] = [];
  let downX = 0;
  let downY = 0;
  let moved = 0;

  const onDown = (e: PointerEvent) => {
    if (e.button !== 0) return;
    downX = e.clientX;
    downY = e.clientY;
    moved = 0;
  };
  const onMove = (e: PointerEvent) => {
    moved = Math.max(moved, Math.hypot(e.clientX - downX, e.clientY - downY));
  };
  const onUp = (e: PointerEvent) => {
    if (e.button !== 0 || moved > CLICK_SLOP_PX) return;
    const rect = dom.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    pending.push({
      x: ((e.clientX - rect.left) / rect.width) * 2 - 1,
      y: -(((e.clientY - rect.top) / rect.height) * 2 - 1),
    });
  };

  dom.addEventListener('pointerdown', onDown);
  dom.addEventListener('pointermove', onMove);
  dom.addEventListener('pointerup', onUp);

  return {
    waves,
    /** 每一格開頭呼叫:收進新的、丟掉過期的 */
    tick(elapsed: number) {
      for (const p of pending.splice(0)) {
        waves.push({x: p.x, y: p.y, startedAt: elapsed});
      }
      while (waves.length > 0 && elapsed - waves[0].startedAt > life) waves.shift();
      while (waves.length > max) waves.shift();
    },
    dispose() {
      dom.removeEventListener('pointerdown', onDown);
      dom.removeEventListener('pointermove', onMove);
      dom.removeEventListener('pointerup', onUp);
    },
  };
}

export function createSceneBase(
  {renderer, width, height, palette}: SceneContext,
  {fov = 45, position, lookAtOrigin = true}: Options,
): SceneBase {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(palette.background);

  const camera = new THREE.PerspectiveCamera(fov, width / height, 0.1, 100);
  camera.position.set(...position);
  if (lookAtOrigin) camera.lookAt(0, 0, 0);

  const tracked: Disposable[] = [];

  return {
    scene,
    camera,
    render: () => renderer.render(scene, camera),
    resize(w, h) {
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    },
    track(resource) {
      tracked.push(resource);
      return resource;
    },
    dispose() {
      for (const resource of tracked) resource.dispose();
      tracked.length = 0;
    },
  };
}
