import { watch, type Ref } from "vue";
import type { Pinia } from "pinia";
import { usePlaybackStore } from "../stores/playback";
import { useScaleStore } from "../stores/scale";
import { useClipTrackPinia } from "../stores/clipTrackPinia";

interface UseAutoScrollOptions {
  scrollLeft: Ref<number>;
  tracksWidth: Ref<number>;
  setScrollLeft: (left: number) => void;
  /** 根组件创建 Pinia 后传入。子组件可省略，改为 inject */
  pinia?: Pinia;
}

/**
 * 播放头越出当前视口时翻到下一/上一视口。
 * 只响应 currentTime 变化（播放推进或用户 seek/点击），手动拖滚动条不会改时间，故不会触发翻页。
 */
export function useAutoScroll({ scrollLeft, tracksWidth, setScrollLeft, pinia }: UseAutoScrollOptions) {
  const bound = pinia ?? useClipTrackPinia();
  const playbackStore = usePlaybackStore(bound);
  const scaleStore = useScaleStore(bound);

  watch(
    () => playbackStore.currentTime,
    (currentTime) => {
      const viewW = tracksWidth.value;
      if (viewW <= 0) return;

      const pixelsPerSecond = scaleStore.actualPixelsPerSecond;
      const cursorPos = currentTime * pixelsPerSecond;
      const visibleStart = scrollLeft.value;
      const visibleEnd = visibleStart + viewW;

      // 仍在当前视口内：不改滚动
      if (cursorPos >= visibleStart && cursorPos <= visibleEnd) return;

      // 按视口宽度整页翻动，让光标落入新视口左侧附近
      const pageIndex = Math.floor(cursorPos / viewW);
      const nextScroll = Math.max(0, pageIndex * viewW);
      if (Math.abs(nextScroll - scrollLeft.value) > 1) {
        setScrollLeft(nextScroll);
      }
    },
  );
}
