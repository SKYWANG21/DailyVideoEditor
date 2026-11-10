import type { TransitionAlgorithm, TransitionEffectDefinition } from "@/types/transition";

/** 每个编辑器独立持有的轻量目录与算法加载缓存。 */
export class TransitionRegistry {
  private definitions = new Map<string, TransitionEffectDefinition>();
  private pending = new Map<string, Promise<TransitionAlgorithm>>();
  private disposed = false;

  /** 可选资源释放入口，供内置 WASM 线程池取消仍在加载的内核。 */
  constructor(private readonly disposeResources?: () => void) {}

  /** 注册算法描述；不允许无意覆盖正在使用的效果。 */
  register(definition: TransitionEffectDefinition): void {
    if (this.disposed) throw new Error("转场注册表已释放");
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
    if (this.disposed) return Promise.reject(new Error("转场注册表已释放"));
    const definition = this.get(id);
    if (!definition) return Promise.reject(new Error(`暂不支持转场：${id}`));
    let pending = this.pending.get(id);
    if (!pending) {
      pending = Promise.resolve()
        .then(() => {
          if (this.disposed) throw new Error("转场注册表已释放");
          return definition.load();
        })
        .then((algorithm) => {
          if (this.disposed) {
            algorithm.dispose?.();
            throw new Error("转场注册表已释放");
          }
          return algorithm;
        })
        .catch((error: unknown) => {
          this.pending.delete(id);
          throw error;
        });
      this.pending.set(id, pending);
    }
    return pending;
  }

  /** 编辑器卸载或宿主结束会话时释放线程；迟到的加载结果也会自动释放。 */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.disposeResources?.();
    const released = new Set<TransitionAlgorithm>();
    for (const pending of this.pending.values()) {
      void pending.then(
        (algorithm) => {
          if (released.has(algorithm)) return;
          released.add(algorithm);
          algorithm.dispose?.();
        },
        () => undefined,
      );
    }
    this.pending.clear();
    this.definitions.clear();
  }
}
