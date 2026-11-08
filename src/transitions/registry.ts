import type { TransitionAlgorithm, TransitionEffectDefinition } from "@/types/transition";

/** 每个编辑器独立持有的轻量目录与算法加载缓存。 */
export class TransitionRegistry {
  private definitions = new Map<string, TransitionEffectDefinition>();
  private pending = new Map<string, Promise<TransitionAlgorithm>>();

  /** 注册算法描述；不允许无意覆盖正在使用的效果。 */
  register(definition: TransitionEffectDefinition): void {
    if (this.definitions.has(definition.id)) throw new Error(`转场已注册：${definition.id}`);
    this.definitions.set(definition.id, definition);
  }

  /** 查询轻量描述，不触发算法下载。 */
  get(id: string): TransitionEffectDefinition | undefined {
    return this.definitions.get(id);
  }

  /** 提供素材面板与手柄菜单使用的目录。 */
  list(): TransitionEffectDefinition[] {
    return [...this.definitions.values()];
  }

  /** 同一效果共用加载任务，失败后允许重试。 */
  resolve(id: string): Promise<TransitionAlgorithm> {
    const definition = this.get(id);
    if (!definition) return Promise.reject(new Error(`暂不支持转场：${id}`));
    let pending = this.pending.get(id);
    if (!pending) {
      pending = Promise.resolve()
        .then(() => definition.load())
        .catch((error: unknown) => {
          this.pending.delete(id);
          throw error;
        });
      this.pending.set(id, pending);
    }
    return pending;
  }
}
