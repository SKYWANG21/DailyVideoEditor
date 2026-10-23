import type { BgmItem, VideoClipItem } from "@/types/videoCompose";
import coolRaw from "@/assets/svg/TextTemplate/cool.svg?raw";
import hiRaw from "@/assets/svg/TextTemplate/hi.svg?raw";
import likeRaw from "@/assets/svg/TextTemplate/like.svg?raw";
import lolRaw from "@/assets/svg/TextTemplate/lol.svg?raw";
import ooopsRaw from "@/assets/svg/TextTemplate/ooops.svg?raw";
import pleaseRaw from "@/assets/svg/TextTemplate/please.svg?raw";
import selfieRaw from "@/assets/svg/TextTemplate/selfie.svg?raw";
import yepRaw from "@/assets/svg/TextTemplate/yep.svg?raw";
import yesRaw from "@/assets/svg/TextTemplate/yes.svg?raw";
import coolUrl from "@/assets/svg/TextTemplate/cool.svg";
import hiUrl from "@/assets/svg/TextTemplate/hi.svg";
import likeUrl from "@/assets/svg/TextTemplate/like.svg";
import lolUrl from "@/assets/svg/TextTemplate/lol.svg";
import ooopsUrl from "@/assets/svg/TextTemplate/ooops.svg";
import pleaseUrl from "@/assets/svg/TextTemplate/please.svg";
import selfieUrl from "@/assets/svg/TextTemplate/selfie.svg";
import yepUrl from "@/assets/svg/TextTemplate/yep.svg";
import yesUrl from "@/assets/svg/TextTemplate/yes.svg";

/**
 * ! MOCK 数据开关 — 调试视频合成 UI 时设为 true；联调/上线前必须改回 false
 * ! true 时忽略 tracks/clips，注入主轨样片、花字模板、音效库
 */
export const USE_MOCK_VIDEO_CLIPS = true;

/** 调试样片。同源 mp4，Worker 才能取到像素；远程地址解析失败时预览会一直空。 */
const MOCK_VIDEO_URLS: string[] = ["/algorithm/test.mp4", "/algorithm/test1.mp4", "/algorithm/test2.mp4"];

/** mock 花字 SVG 文件（id + 原文 + 打包地址） */
export interface MockTextTemplateFile {
  /** 文件名，同时作为模板 id */
  id: string;
  /** SVG 原文 */
  raw: string;
  /** 打包后的资源地址 */
  url: string;
}

const MOCK_TEXT_TEMPLATE_FILES: MockTextTemplateFile[] = [
  { id: "cool", raw: coolRaw, url: coolUrl },
  { id: "hi", raw: hiRaw, url: hiUrl },
  { id: "like", raw: likeRaw, url: likeUrl },
  { id: "lol", raw: lolRaw, url: lolUrl },
  { id: "ooops", raw: ooopsRaw, url: ooopsUrl },
  { id: "please", raw: pleaseRaw, url: pleaseUrl },
  { id: "selfie", raw: selfieRaw, url: selfieUrl },
  { id: "yep", raw: yepRaw, url: yepUrl },
  { id: "yes", raw: yesRaw, url: yesUrl },
];

/** public/algorithm/audio 下调试样效文件名（不含扩展名作展示名） */
const MOCK_SFX_NAMES: string[] = [
  "系统警告",
  "牛叫",
  "闪亮登场",
  "突然加速",
  "综艺尴尬背景音",
  "鼠标点击声",
  "疑问",
  "警告音",
  "颤抖",
  "魔法音效",
  "滴",
];

/** 是否启用 mock（主轨 / 花字 / 音效） */
export function isVideoComposeMockEnabled(): boolean {
  return USE_MOCK_VIDEO_CLIPS;
}

/** ! 调试用 mock 片段列表 */
export function buildMockVideoClips(): VideoClipItem[] {
  return MOCK_VIDEO_URLS.map((url, i) => ({
    id: `clip-${i + 1}`,
    title: `片段 ${i + 1}`,
    url,
    durationSec: 0,
    src: "",
  }));
}

/** mock 花字源文件，供 textTemplateCatalog 解析写入缓存 */
export function getMockTextTemplateFiles(): MockTextTemplateFile[] {
  return MOCK_TEXT_TEMPLATE_FILES;
}

/** mock 音效库。durationSec=0，拖入时间轴时按占位 0.1s 处理 */
export function buildMockSfxAssets(): BgmItem[] {
  return MOCK_SFX_NAMES.map((name) => ({
    name,
    url: `/algorithm/audio/${name}.mp3`,
    durationSec: 0,
  }));
}
