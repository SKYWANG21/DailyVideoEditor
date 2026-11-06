import { defineStore, getActivePinia } from "pinia";
import { ref, computed } from "vue";
import type { HistoryItem } from "../types";
import { useTracksStore } from "./tracks";

export const useHistoryStore = defineStore("history", () => {
  const pinia = getActivePinia();
  if (!pinia) throw new Error("history store 需要 Pinia 实例");

  /** 绑定创建本 store 时的 Pinia，避免事后读到别的编辑器 */
  function boundTracksStore() {
    return useTracksStore(pinia);
  }

  // 状态
  const historyStack = ref<HistoryItem[]>([]);
  const currentIndex = ref(-1);
  const maxHistorySize = ref(50); // 最多保存 50 条历史记录

  /**
   * 批量深度：>0 时 pushSnapshot 忽略，由 endHistoryBatch 统一提交一条。
   * 用于一次业务里多次 add/update/remove。
   */
  let batchDepth = 0;
  /** 当前批次默认描述（begin 时可带，end 可覆盖） */
  let batchDescription: string | undefined;
  /** 静默深度：>0 时完全不记历史（空轨清理等） */
  let silenceDepth = 0;

  // 计算属性
  const canUndo = computed(() => currentIndex.value > 0);
  const canRedo = computed(() => currentIndex.value < historyStack.value.length - 1);

  // 方法：创建快照
  function createSnapshot(description?: string): HistoryItem {
    const tracksStore = boundTracksStore();
    const snapshot: HistoryItem = {
      id: `${Date.now()}-${Math.random()}`,
      timestamp: Date.now(),
      snapshot: JSON.stringify({
        tracks: tracksStore.tracks,
        selectedClipIds: Array.from(tracksStore.selectedClipIds),
      }),
      description,
    };
    return snapshot;
  }

  /** 真正写入历史栈（不受 batch 抑制；仍受 silence 抑制） */
  function commitSnapshot(description?: string) {
    if (silenceDepth > 0) return;

    const snapshot = createSnapshot(description);

    // 如果当前不在栈顶，删除当前位置之后的所有历史
    if (currentIndex.value < historyStack.value.length - 1) {
      historyStack.value = historyStack.value.slice(0, currentIndex.value + 1);
    }

    // 添加新快照
    historyStack.value.push(snapshot);

    // 限制历史记录数量：溢出时丢掉最旧一条，下标仍指向最新
    if (historyStack.value.length > maxHistorySize.value) {
      historyStack.value.shift();
      currentIndex.value = historyStack.value.length - 1;
    } else {
      currentIndex.value++;
    }
  }

  // 方法：保存快照（批量中忽略，结束批次时再 commit）
  function pushSnapshot(description?: string) {
    if (silenceDepth > 0 || batchDepth > 0) return;
    commitSnapshot(description);
  }

  /**
   * 开始合并历史：其间 pushSnapshot 不入栈。
   * @param description 批次默认说明，end 时可覆盖
   */
  function beginHistoryBatch(description?: string) {
    if (batchDepth === 0) batchDescription = description;
    batchDepth += 1;
  }

  /**
   * 结束合并历史并提交一条快照（深度归零时）。
   * @param description 覆盖 begin 时的说明；传空串仍提交
   */
  function endHistoryBatch(description?: string) {
    if (batchDepth <= 0) return;
    batchDepth -= 1;
    if (batchDepth > 0) return;
    const label = description !== undefined ? description : batchDescription;
    batchDescription = undefined;
    commitSnapshot(label);
  }

  /**
   * 在回调内不写任何历史（用于空轨清理等副作用）。
   * @param fn 同步回调
   */
  function runWithoutHistory(fn: () => void) {
    silenceDepth += 1;
    try {
      fn();
    } finally {
      silenceDepth -= 1;
    }
  }

  // 方法：恢复快照
  function restoreSnapshot(snapshot: HistoryItem) {
    const tracksStore = boundTracksStore();
    const data = JSON.parse(snapshot.snapshot);

    // 恢复轨道数据
    tracksStore.tracks = data.tracks;

    // 恢复选中状态
    tracksStore.selectedClipIds.clear();
    data.selectedClipIds.forEach((id: string) => {
      tracksStore.selectedClipIds.add(id);
    });
  }

  // 方法：撤销
  function undo() {
    if (!canUndo.value) return;

    currentIndex.value--;
    const snapshot = historyStack.value[currentIndex.value];
    restoreSnapshot(snapshot);
  }

  // 方法：重做
  function redo() {
    if (!canRedo.value) return;

    currentIndex.value++;
    const snapshot = historyStack.value[currentIndex.value];
    restoreSnapshot(snapshot);
  }

  // 方法：初始化历史（保存初始状态）
  function initialize() {
    batchDepth = 0;
    batchDescription = undefined;
    silenceDepth = 0;
    historyStack.value = [];
    currentIndex.value = -1;
    commitSnapshot("初始状态");
  }

  // 方法：清空历史
  function clear() {
    batchDepth = 0;
    batchDescription = undefined;
    silenceDepth = 0;
    historyStack.value = [];
    currentIndex.value = -1;
  }

  // 方法：重置
  function reset() {
    clear();
  }

  return {
    // 状态
    historyStack,
    currentIndex,
    maxHistorySize,

    // 计算属性
    canUndo,
    canRedo,

    // 方法
    createSnapshot,
    pushSnapshot,
    beginHistoryBatch,
    endHistoryBatch,
    runWithoutHistory,
    restoreSnapshot,
    undo,
    redo,
    initialize,
    clear,
    reset,
  };
});
