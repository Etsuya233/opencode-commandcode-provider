/**
 * RPC contract shared by the server plugin and its terminal companion.
 *
 * The server plugin owns the catalog and the `/commandcode-refresh` command,
 * but it cannot draw in the terminal: the only session-native way to surface
 * text (`session.synthetic`) is a model-visible user message that also starts a
 * provider turn. So the refresh result travels over an RPC event instead, and
 * `tui.ts` turns it into a toast.
 *
 * The definition is plain JSON-Schema data rather than a call to `Rpc.define`
 * from `@opencode/plugin`: opencode hands plugins a structural `rpc` domain, and
 * the published typings are not the runtime this provider targets. Only the
 * shapes below are actually used by the host.
 */

export const COMMANDCODE_RPC_ID = "commandcode"

/** Emitted after a manual refresh, once the new catalog is live. */
export const REFRESH_EVENT = "refreshed"

/** What the terminal companion needs to render the refresh result. */
export interface RefreshNotice {
  readonly message: string
  readonly variant: "success" | "error"
  /** Lets the toast offer to open the session that asked for the refresh. */
  readonly sessionID?: string
}

export const COMMANDCODE_RPC = {
  id: COMMANDCODE_RPC_ID,
  methods: {},
  events: {
    [REFRESH_EVENT]: {
      schema: {
        type: "object",
        properties: {
          message: { type: "string" },
          variant: { type: "string" },
          sessionID: { type: "string" },
        },
        required: ["message", "variant"],
        additionalProperties: false,
      },
    },
  },
} as const
