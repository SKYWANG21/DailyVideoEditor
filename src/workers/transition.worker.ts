import { TransitionWorkerRuntime, type TransitionWorkerScope } from "./transitionRuntime";

export { TransitionWorkerRuntime } from "./transitionRuntime";

if (typeof self !== "undefined") {
  const scope = self as unknown as TransitionWorkerScope;
  const runtime = new TransitionWorkerRuntime((message, transfer) => scope.postMessage(message, transfer));
  scope.onmessage = ({ data }): void => runtime.accept(data);
}
