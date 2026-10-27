/**
 * 水波。
 *
 * 一片格線平面,靠頂點位移做出漣漪:兩道持續的環形波 + 跟著指標跑的一道,
 * 再加上**點一下就從那裡擴散出去**的那幾道。
 * 用 wireframe 而不是實心面 —— 實心面在單色佈景下看起來只是一塊會抖的色塊,
 * 線框才看得出「水」的形狀。
 */
import * as THREE from 'three';

import {createClickWaves, createSceneBase} from './base';
import {easeStep, frameDelta} from '../../lib/frameEase';
import type {SceneContext, SceneFactory, SceneHandle} from './types';

/**
 * 格線的分段數。**登入頁那塊是整個右半版面,線密才看得出水的形狀。**
 * ⚠️ 它是**平方**成本((n+1)² 個頂點,每個每格跑三次 `sin` 加一次 `hypot`),
 * 調高之前先想想那是誰在跑。
 */
const SEGMENTS = 72;
const SIZE = 4.2;

/**
 * 平面自己的傾角。
 *
 * 鏡頭壓低 + 平面側傾,水面才是「斜看過去」的樣子;
 * 正對著看的話那片格線只是一張抖動的網子,看不出它是一個平面。
 */
const TILT = 0.17;

/** 點出來的那道波:活多久、跑多快、多高、環有多窄 */
const CLICK_LIFE = 4.2;
const CLICK_SPEED = 1.35;
const CLICK_AMP = 0.42;
const CLICK_RING = 5.5;

export const ripple: SceneFactory = {
  name: 'ripple',
  create(ctx: SceneContext): SceneHandle {
    const {palette, reducedMotion} = ctx;
    // 鏡頭放低:低一點才是掠過水面的角度,高的話就變成俯視地圖
    const stage = createSceneBase(ctx, {position: [0, 1.75, 3.9]});
    const clicks = createClickWaves(ctx, {life: CLICK_LIFE});

    const geometry = stage.track(new THREE.PlaneGeometry(SIZE, SIZE, SEGMENTS, SEGMENTS));
    geometry.rotateX(-Math.PI / 2);

    const material = stage.track(
      new THREE.MeshBasicMaterial({
        color: palette.accent,
        wireframe: true,
        transparent: true,
        opacity: 0.55,
      }),
    );
    const mesh = new THREE.Mesh(geometry, material);
    mesh.rotation.z = TILT;
    stage.scene.add(mesh);

    // 原始座標留一份:每格都從原點重算,不能在上一格的結果上累加(會越積越歪)。
    const base = geometry.attributes.position.array.slice() as Float32Array;
    const position = geometry.attributes.position;

    const drop = new THREE.Vector2(0, 0);
    /** 上一次 update 的時間(ms);追指標的比例照兩次之間過了多久換算 */
    let lastMs: number | undefined;

    function update(elapsed: number, pointer: {x: number; y: number}) {
      const t = reducedMotion ? 0.8 : elapsed;
      clicks.tick(elapsed);

      // 指標位置換算成平面上的座標,慢慢追過去(不要瞬移,會像閃爍)。
      // 0.06 是「每 60Hz 一幀」的比例,照實際 dt 換算
      const ms = elapsed * 1000;
      const k = easeStep(0.06, frameDelta(lastMs, ms));
      lastMs = ms;
      drop.x += ((pointer.x * SIZE) / 2 - drop.x) * k;
      drop.y += ((-pointer.y * SIZE) / 2 - drop.y) * k;

      const arr = position.array as Float32Array;
      for (let i = 0; i < arr.length; i += 3) {
        const x = base[i];
        const z = base[i + 2];
        const r1 = Math.hypot(x, z);
        const r2 = Math.hypot(x - drop.x, z - drop.y);
        let h =
          Math.sin(r1 * 3.2 - t * 1.6) * 0.16 +
          Math.sin((x + z) * 1.4 + t * 0.9) * 0.06 +
          Math.sin(r2 * 5.5 - t * 3.4) * (0.22 / (1 + r2 * 2.2));

        // 點出來的那幾道:一圈往外跑的高斯環,越跑越淡也越矮
        for (const w of clicks.waves) {
          const age = elapsed - w.startedAt;
          const cx = (w.x * SIZE) / 2;
          const cz = (-w.y * SIZE) / 2;
          const front = Math.hypot(x - cx, z - cz) - age * CLICK_SPEED;
          // 只有環附近要算,遠的直接跳過 —— 這一段一格要跑五千多次
          if (front < -0.9 || front > 0.9) continue;
          const fade = 1 - age / CLICK_LIFE;
          h += Math.sin(front * CLICK_RING) * Math.exp(-front * front * 6) * CLICK_AMP * fade * fade;
        }
        arr[i + 1] = h;
      }
      position.needsUpdate = true;
      mesh.rotation.y = Math.sin(t * 0.12) * 0.12 + pointer.x * 0.12;
      stage.render();
    }

    return {
      update,
      resize: stage.resize,
      dispose() {
        clicks.dispose();
        stage.dispose();
      },
    };
  },
};
