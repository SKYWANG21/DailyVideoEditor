import { watch, type Ref } from 'vue'
import type { Pinia } from 'pinia'
import { usePlaybackStore } from '../stores/playback'
import { useScaleStore } from '../stores/scale'
import { useClipTrackPinia } from '../stores/clipTrackPinia'

interface UseAutoScrollOptions {
  scrollLeft: Ref<number>
  tracksWidth: Ref<number>
  setScrollLeft: (left: number) => void
  /** 根组件创建 Pinia 后传入。子组件可省略，改为 inject */
  pinia?: Pinia
}

export function useAutoScroll({ scrollLeft, tracksWidth, setScrollLeft, pinia }: UseAutoScrollOptions) {
  const bound = pinia ?? useClipTrackPinia()
  const playbackStore = usePlaybackStore(bound)
  const scaleStore = useScaleStore(bound)

  watch(
    () => playbackStore.currentTime,
    (currentTime) => {
      if (!playbackStore.isPlaying) return

      const pixelsPerSecond = scaleStore.actualPixelsPerSecond
      const currentPos = currentTime * pixelsPerSecond
      const visibleStart = scrollLeft.value
      // const visibleEnd = visibleStart + tracksWidth.value

      // 检查是否接近右边缘 (90%)
      const threshold = visibleStart + tracksWidth.value * 0.9

      if (currentPos > threshold) {
        // 向右滚动 80% 的可视宽度
        const scrollAmount = tracksWidth.value * 0.8
        const newScrollLeft = scrollLeft.value + scrollAmount
        setScrollLeft(newScrollLeft)
      }
    }
  )
}
