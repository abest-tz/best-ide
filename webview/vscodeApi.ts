import type { ToExtensionMessage } from '../src/shared/protocol';

interface VsCodeApi {
  postMessage(message: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

const api = acquireVsCodeApi();

export function postToExtension(message: ToExtensionMessage): void {
  api.postMessage(message);
}
