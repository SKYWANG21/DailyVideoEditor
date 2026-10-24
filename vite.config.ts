import { cpSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, URL } from "node:url";
import { defineConfig, type Plugin } from "vite";
import vue from "@vitejs/plugin-vue";
import tailwindcss from "@tailwindcss/vite";
import dts from "vite-plugin-dts";

const rootDir = fileURLToPath(new URL(".", import.meta.url));

/** 库构建把美颜模型拷到 dist/algorithm，宿主可放到自己的静态目录 */
function copyAlgorithmAssets(): Plugin {
  return {
    name: "copy-algorithm-assets",
    apply: "build",
    closeBundle() {
      const dest = resolve(rootDir, "dist/algorithm");
      mkdirSync(dest, { recursive: true });
      cpSync(resolve(rootDir, "public/algorithm/face_landmarker.task"), resolve(dest, "face_landmarker.task"));
      cpSync(resolve(rootDir, "public/algorithm/mediapipe"), resolve(dest, "mediapipe"), { recursive: true });
    },
  };
}

/** 把抽出的 CSS 固定成 dist/style.css */
function emitStyleCss(): Plugin {
  return {
    name: "emit-style-css",
    apply: "build",
    generateBundle(_options, bundle) {
      for (const file of Object.values(bundle)) {
        if (file.type === "asset" && file.fileName.endsWith(".css")) {
          file.fileName = "style.css";
        }
      }
    },
  };
}

export default defineConfig(({ mode }) => {
  const lib = mode === "lib";
  return {
    plugins: [
      vue(),
      tailwindcss(),
      ...(lib
        ? [
            emitStyleCss(),
            copyAlgorithmAssets(),
            dts({
              tsconfigPath: "./tsconfig.json",
              // 关闭合并：Windows 上 rollupTypes 清理 dist 时 lstat 会 EPERM。入口声明仍是 dist/index.d.ts
              rollupTypes: false,
              insertTypesEntry: false,
              exclude: ["node_modules/**", "src/App.vue", "src/main.ts"],
            }),
          ]
        : []),
    ],
    resolve: {
      alias: {
        "@": fileURLToPath(new URL("./src", import.meta.url)),
      },
    },
    server: {
      port: 7010,
    },
    publicDir: lib ? false : "public",
    worker: {
      format: "es" as const,
    },
    optimizeDeps: {
      exclude: ["@mediapipe/tasks-vision"],
    },
    build: lib
      ? {
          emptyOutDir: true,
          cssCodeSplit: false,
          lib: {
            entry: fileURLToPath(new URL("./src/index.ts", import.meta.url)),
            formats: ["es"],
            fileName: "index",
          },
          rollupOptions: {
            external: (id) => id === "vue" || id.startsWith("vue/") || id.startsWith("@vue/"),
            output: {
              assetFileNames: (assetInfo) => {
                const name = assetInfo.names?.[0] ?? assetInfo.name ?? "";
                if (name.endsWith(".css")) return "style.css";
                return "assets/[name]-[hash][extname]";
              },
            },
          },
        }
      : undefined,
  };
});
