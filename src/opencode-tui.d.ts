/**
 * Minimal structural types for `@opencode/plugin/tui`.
 *
 * Same rationale as `opencode-api.ts`: the plugin targets the runtime opencode
 * actually loads, and the host resolves this import itself for discovered CLI
 * plugins. This file only declares what `tui.ts` uses.
 */

declare module "@opencode/plugin/tui" {
  export type ToastVariant = "info" | "success" | "warning" | "error"

  export interface ToastOptions {
    readonly title?: string
    readonly message: string
    readonly variant?: ToastVariant
    readonly duration?: number
    /** Links the toast to a session so it can offer to open it. */
    readonly sessionID?: string
  }

  /** A payload from an RPC event stream; `data` is the shape the server sent. */
  export interface RpcEvent {
    readonly type: string
    readonly data: unknown
    readonly location: unknown
  }

  export interface RpcEvents {
    on(name: string, handler: (event: RpcEvent) => void): () => void
    subscribe(name: string): AsyncIterable<RpcEvent>
  }

  export interface RpcClient {
    readonly events: RpcEvents
  }

  export interface Client {
    /** Creates a subclient for an RPC definition exported by a server plugin. */
    rpc(definition: unknown): RpcClient
  }

  export interface Context {
    readonly options: Readonly<Record<string, unknown>>
    readonly client: Client
    readonly ui: {
      readonly toast: {
        show(options: ToastOptions): void
      }
    }
  }

  export type Cleanup = () => Promise<void> | void

  export interface Definition {
    readonly id: string
    readonly setup: (context: Context) => Promise<Cleanup | void> | Cleanup | void
  }

  export const Plugin: {
    define(plugin: Definition): Definition
  }
}
