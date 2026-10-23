import type { App } from "vue";
import { ElColorPicker, ElInputNumber, ElSlider, ElSwitch } from "element-plus";

const INSTALLED = Symbol("videoClipsElementPlus");

/**
 * 在宿主应用上登记编辑器模板用到的 Element Plus 组件。
 * 不调用 app.use(ElementPlus)，避免宿主必须全量注册。
 */
export function installComposeElementPlus(app: App): void {
  const marked = app as App & { [INSTALLED]?: boolean };
  if (marked[INSTALLED]) return;
  marked[INSTALLED] = true;
  app.component(ElSwitch.name || "ElSwitch", ElSwitch);
  app.component(ElSlider.name || "ElSlider", ElSlider);
  app.component(ElInputNumber.name || "ElInputNumber", ElInputNumber);
  app.component(ElColorPicker.name || "ElColorPicker", ElColorPicker);
}
