import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// 使用支持 wasm32 的 LLVM Clang（Emscripten SDK 自带）；不链接浏览器胶水或 WASI。
const root = new URL("../", import.meta.url);
const result = spawnSync(
  process.env.WASM_CLANG || "clang",
  [
    "--target=wasm32",
    "-O3",
    "-ffreestanding",
    "-fno-builtin",
    "-nostdlib",
    "-Wl,--no-entry",
    "-Wl,--export=render",
    "-Wl,--export=__heap_base",
    "-Wl,--export-memory",
    "-Wl,--strip-all",
    "src/transitions/wasm/crossfade.c",
    "-o",
    "src/transitions/wasm/crossfade.wasm",
  ],
  { cwd: fileURLToPath(root), stdio: "inherit", windowsHide: true },
);
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
