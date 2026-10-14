import type { Protocol } from 'electron';

export function ensurePresentationProtocol(protocol: Protocol, handler: Parameters<Protocol['handle']>[1]): void {
  // A popup's partition keeps its session (and handler) after the window closes.
  if (!protocol.isProtocolHandled('codex-presentation')) protocol.handle('codex-presentation', handler);
}
