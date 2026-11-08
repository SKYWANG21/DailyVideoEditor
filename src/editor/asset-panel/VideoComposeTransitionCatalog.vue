<template>
  <div class="transition-catalog">
    <button
      v-for="effect in effects"
      :key="effect.id"
      type="button"
      class="transition-card"
      :draggable="!readonly"
      :disabled="readonly"
      :title="`${effect.description}；拖到接缝或双击应用`"
      @mouseenter="startPreview(effect.id)"
      @mouseleave="stopPreview"
      @focus="startPreview(effect.id)"
      @blur="stopPreview"
      @dragstart="drag($event, effect.id)"
      @dblclick="emit('apply', effect.id)"
    >
      <canvas :ref="(el) => setCanvas(effect.id, el)" class="transition-card__canvas" width="144" height="96" aria-hidden="true" />
      <span>{{ effect.name }}</span>
    </button>
    <p class="transition-catalog__hint">拖到主轨接缝，或选中片段后双击应用</p>
  </div>
</template>

<script setup lang="ts">
import { onBeforeUnmount, onMounted, type ComponentPublicInstance } from "vue";
import { createTransitionRegistry } from "@/transitions/catalog";
import { TransitionEngine } from "@/transitions/engine";
import { TRANSITION_DRAG_MIME } from "@/transitions/timing";

/** 卡片使用真实引擎演示，不另写 CSS 转场。 */
defineProps<{ readonly?: boolean }>();
const emit = defineEmits<{ apply: [effectId: string] }>();
const registry = createTransitionRegistry();
const engine = new TransitionEngine(registry);
const effects = registry.list();
const canvases = new Map<string, HTMLCanvasElement>();
let raf = 0;
let revision = 0;
let disposed = false;
/** 保存当前缩略图节点。 */
function setCanvas(id: string, element: Element | ComponentPublicInstance | null): void {
  if (element instanceof HTMLCanvasElement) canvases.set(id, element);
  else canvases.delete(id);
}
/** 用主题色测试帧演示算法。 */
async function paint(id: string, progress: number, token: number): Promise<void> {
  const target = canvases.get(id);
  if (!target) return;
  const style = getComputedStyle(target);
  const a = new OffscreenCanvas(144, 96);
  const b = new OffscreenCanvas(144, 96);
  for (const [canvas, color, label] of [
    [a, style.getPropertyValue("--compose-accent"), "A"],
    [b, style.getPropertyValue("--compose-fg-2"), "B"],
  ] as const) {
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, 144, 96);
    ctx.fillStyle = style.getPropertyValue("--compose-surface");
    ctx.font = "600 24px sans-serif";
    ctx.fillText(label, 60, 58);
  }
  try {
    const result = await engine.render({ effectId: id, outgoing: a, incoming: b, width: 144, height: 96, progress, params: {} });
    if (!disposed && token === revision) target.getContext("2d")?.drawImage(result, 0, 0);
  } catch {
    if (!disposed && token === revision) target.getContext("2d")?.drawImage(a, 0, 0);
  }
}
/** 减少动效时只展示静态缩略图。 */
function startPreview(id: string): void {
  stopPreview();
  const token = revision;
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const start = performance.now();
  const tick = async (): Promise<void> => {
    await paint(id, ((performance.now() - start) % 1600) / 1600, token);
    if (token === revision && !disposed) raf = requestAnimationFrame(() => void tick());
  };
  void tick();
}
/** 卡片离开后停止后台渲染。 */
function stopPreview(): void {
  revision += 1;
  cancelAnimationFrame(raf);
}
/** 载荷只含效果标识。 */
function drag(event: DragEvent, id: string): void {
  if (!event.dataTransfer) return;
  event.dataTransfer.effectAllowed = "copy";
  event.dataTransfer.setData(TRANSITION_DRAG_MIME, id);
}
onMounted(() => {
  for (const effect of effects) void paint(effect.id, 0.5, revision);
});
onBeforeUnmount(() => {
  disposed = true;
  stopPreview();
});
</script>

<style scoped>
.transition-catalog {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
}
.transition-card {
  display: flex;
  width: 72px;
  flex-direction: column;
  gap: 8px;
  border: 0;
  padding: 0;
  background: transparent;
  color: var(--compose-fg);
  font-size: 12px;
  cursor: pointer;
}
.transition-card__canvas {
  width: 72px;
  height: 48px;
  border-radius: 12px;
}
.transition-card:focus-visible {
  outline: 2px solid var(--compose-accent);
  outline-offset: 4px;
}
.transition-catalog__hint {
  margin: 0;
  width: 100%;
  color: var(--compose-fg-3);
  font-size: 12px;
}
</style>
