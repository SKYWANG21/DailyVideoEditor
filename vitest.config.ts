import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vitest/config";

/** 单元测试不加载库构建与模型拷贝插件。 */
export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  test: { environment: "node", include: ["tests/**/*.test.ts"], clearMocks: true },
});
