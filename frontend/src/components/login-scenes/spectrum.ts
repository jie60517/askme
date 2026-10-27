/**
 * 聲波。
 *
 * 一排長條,高度由幾個不同頻率的正弦疊出來 —— 不接麥克風(登入頁跳權限請求很怪),
 * 但疊三個互質的頻率就不會看出循環,肉眼跟真的頻譜分不出來。
 * 指標的水平位置會把附近的長條推高,像手指劃過。
 * 這一款刻意維持這個大小、不接點擊。
 */
import * as THREE from 'three';

import {createSceneBase} from './base';
import {easeStep, frameDelta} from '../../lib/frameEase';
import type {SceneContext, SceneFactory, SceneHandle} from './types';

const BARS = 34;
const BAR_WIDTH = 0.09;
const SPREAD = 3.6;

export const spectrum: SceneFactory = {
  name: 'spectrum',
  create(ctx: SceneContext): SceneHandle {
    const {palette, reducedMotion} = ctx;
    const stage = createSceneBase(ctx, {position: [0, 0, 5], lookAtOrigin: false});

    const geometry = stage.track(new THREE.PlaneGeometry(BAR_WIDTH, 1));
    // 讓長條從底部長高,而不是從中心往兩邊撐
    geometry.translate(0, 0.5, 0);

    const material = stage.track(new THREE.MeshBasicMaterial({color: palette.accent}));
    const bars = stage.track(new THREE.InstancedMesh(geometry, material, BARS));
    stage.scene.add(bars);

    const mirror = stage.track(
      new THREE.MeshBasicMaterial({
        color: palette.accent,
        transparent: true,
        opacity: 0.18,
      }),
    );
    const reflection = stage.track(new THREE.InstancedMesh(geometry, mirror, BARS));
    stage.scene.add(reflection);

    const dummy = new THREE.Object3D();
    const heights = new Float32Array(BARS).fill(0.1);
    /** 上一次 update 的時間(ms);長條追高度的比例照兩次之間過了多久換算 */
    let lastMs: number | undefined;

    function update(elapsed: number, pointer: {x: number; y: number}) {
      const t = reducedMotion ? 1.2 : elapsed;
      const ms = elapsed * 1000;
      // 0.18 是「每 60Hz 一幀」的比例,照實際 dt 換算
      const follow = reducedMotion ? 1 : easeStep(0.18, frameDelta(lastMs, ms));
      lastMs = ms;
      for (let i = 0; i < BARS; i += 1) {
        const n = i / (BARS - 1);
        const x = (n - 0.5) * SPREAD;

        // 三個互質頻率疊起來,看不出循環
        let amp =
          Math.sin(n * 7.3 + t * 2.1) * 0.35 +
          Math.sin(n * 13.1 - t * 1.3) * 0.22 +
          Math.sin(n * 3.7 + t * 3.9) * 0.18;
        amp = Math.abs(amp) + 0.06;

        // 指標附近推高
        const near = Math.max(0, 1 - Math.abs(pointer.x * (SPREAD / 2) - x) * 1.6);
        amp += near * near * 0.7;

        // 追過去而不是直接設,長條才不會每格跳動
        heights[i] += (amp - heights[i]) * follow;

        dummy.position.set(x, 0.04, 0);
        dummy.scale.set(1, heights[i], 1);
        dummy.updateMatrix();
        bars.setMatrixAt(i, dummy.matrix);

        dummy.position.set(x, -0.04, 0);
        dummy.scale.set(1, -heights[i] * 0.45, 1);
        dummy.updateMatrix();
        reflection.setMatrixAt(i, dummy.matrix);
      }
      bars.instanceMatrix.needsUpdate = true;
      reflection.instanceMatrix.needsUpdate = true;
      stage.render();
    }

    return {update, resize: stage.resize, dispose: stage.dispose};
  },
};
