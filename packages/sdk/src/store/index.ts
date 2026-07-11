/**
 * ChatStore — the persistence seam (same pattern as Sandbox).
 *
 * The SDK defines the interface and ships `IndexedDBStore` (store/indexeddb.ts)
 * as the default; apps swap in a remote implementation (Postgres, Supabase,
 * your API) without touching Chat. This module has zero DB imports so server-
 * side store implementations never pull browser storage code.
 *
 * Snapshots are saved once per completed turn (on `agent_end`), never per text
 * delta — the interface must stay cheap enough for a network round-trip.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";

export interface ChatSnapshot {
  /** Schema version, for future migrations. */
  version: 1;
  /** Full conversation transcript. */
  messages: AgentMessage[];
  /** Workspace contents, keyed by relative path. */
  files: Record<string, string>;
  /**
   * Write timestamp (ms). Remote stores can use this for optimistic
   * concurrency — reject saves older than what they already hold.
   */
  updatedAt: number;
}

export interface ChatStore {
  load(id: string): Promise<ChatSnapshot | null>;
  save(id: string, snapshot: ChatSnapshot): Promise<void>;
  /** Optional: enumerate stored chats, for session pickers. */
  list?(): Promise<{ id: string; updatedAt: number }[]>;
  /** Optional: remove a stored chat. */
  delete?(id: string): Promise<void>;
}
