import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// 使用支持 wasm32 的 LLVM Clang（Emscripten SDK 自带）；不链接浏览器胶水或 WASI。
const root = new URL("../", import.meta.url);
const effects = ["zoom-in", "fade-black", "zoom-out", "blinds", "blinds-diagonal", "wipe-right", "wipe-left", "split-open", "shake"];
const kernels = [
  { id: "crossfade", source: "crossfade.c", defines: [] },
  ...effects.map((id, index) => ({ id, source: "effects.c", defines: [`-DTRANSITION_EFFECT=${index + 1}`] })),
];
for (const kernel of kernels) {
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
      ...kernel.defines,
      `src/transitions/wasm/${kernel.source}`,
      "-o",
      `src/transitions/wasm/${kernel.id}.wasm`,
    ],
    { cwd: fileURLToPath(root), stdio: "inherit", windowsHide: true },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    process.exitCode = result.status ?? 1;
    break;
  }
  console.log(`Built ${kernel.id}.wasm`);
}
