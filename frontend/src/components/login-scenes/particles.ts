/**
 * 粒子場。
 *
 * 一團慢慢飄的點,指標靠近會把它們推開,放開又慢慢回到原位。
 * 每顆點自己記著「家」的座標 —— 只做推力不記家的話,滑幾下就全被掃到角落了。
 */
import * as THREE from 'three';

import {createSceneBase} from './base';
import {easeStep, FRAME_MS, frameDelta} from '../../lib/frameEase';
import type {SceneContext, SceneFactory, SceneHandle} from './types';

const COUNT = 900;
const FIELD = 3.4;

export const particles: SceneFactory = {
  name: 'particles',
  create(ctx: SceneContext): SceneHandle {
    const {palette, reducedMotion} = ctx;
    const stage = createSceneBase(ctx, {fov: 50, position: [0, 0, 4.2], lookAtOrigin: false});

    const home = new Float32Array(COUNT * 3);
    const positions = new Float32Array(COUNT * 3);
    for (let i = 0; i < COUNT; i += 1) {
      // 球殼上取點,中間比較空,看起來才有體積
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(2 * Math.random() - 1);
      const r = FIELD * (0.55 + Math.random() * 0.45);
      home[i * 3] = r * Math.sin(phi) * Math.cos(theta);
      home[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta) * 0.7;
      home[i * 3 + 2] = r * Math.cos(phi) * 0.6;
      positions.set(home.subarray(i * 3, i * 3 + 3), i * 3);
    }

    const geometry = stage.track(new THREE.BufferGeometry());
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));

    const material = stage.track(
      new THREE.PointsMaterial({
        color: palette.accent,
        size: 0.028,
        sizeAttenuation: true,
        transparent: true,
        opacity: 0.85,
      }),
    );
    const points = new THREE.Points(geometry, material);
    stage.scene.add(points);

    const cursor = new THREE.Vector3();
    /** 上一次 update 的時間(ms);回家的比例與推力都照兩次之間過了多久換算 */
    let lastMs: number | undefined;

    function update(elapsed: number, pointer: {x: number; y: number}) {
      const t = reducedMotion ? 0 : elapsed;
      cursor.set(pointer.x * FIELD * 0.8, pointer.y * FIELD * 0.5, 0);
      /*
       * 0.045(回家)與 0.06(推力)都是「每 60Hz 一幀」的量:
       * 回家是指數逼近 → easeStep;推力是每幀加一次的位移 → 照幀數線性放大。
       * ⚠️ 減少動態時 elapsed 永遠是 0:第一次當一幀算,
       * 之後 dt = 0、不再動 —— resize 補畫的那一格不會再推一次。
       */
      const ms = elapsed * 1000;
      const dtMs = frameDelta(lastMs, ms);
      lastMs = ms;
      const homeK = easeStep(0.045, dtMs);
      const pushK = 0.06 * (dtMs / FRAME_MS);

      const arr = geometry.attributes.position.array as Float32Array;
      for (let i = 0; i < COUNT; i += 1) {
        const o = i * 3;
        const hx = home[o];
        const hy = home[o + 1] + Math.sin(t * 0.6 + hx * 1.3) * 0.08;
        const hz = home[o + 2];

        const dx = arr[o] - cursor.x;
        const dy = arr[o + 1] - cursor.y;
        const d2 = dx * dx + dy * dy + 0.12;
        const push = Math.min(0.9, 0.55 / d2);

        // 推力 + 回家的彈力,兩者相加才會有「被撥開又聚回來」的手感
        arr[o] += (hx - arr[o]) * homeK + dx * push * pushK;
        arr[o + 1] += (hy - arr[o + 1]) * homeK + dy * push * pushK;
        arr[o + 2] += (hz - arr[o + 2]) * homeK;
      }
      geometry.attributes.position.needsUpdate = true;

      points.rotation.y = t * 0.05;
      stage.render();
    }

    return {update, resize: stage.resize, dispose: stage.dispose};
  },
};
