/**
 * Terminal companion for the Command Code provider.
 *
 * The server plugin cannot draw in the terminal, and the only session-native
 * way to surface text is a model-visible synthetic message that also starts a
 * provider turn. So `plugin.ts` broadcasts the refresh result over an RPC event
 * and this entry renders it as a toast instead.
 *
 * This is terminal-only on purpose: the web UI renders sessions, not plugin
 * notifications, so it has no equivalent channel. Exporting `./tui` from
 * `package.json` is what makes the CLI load this alongside the server plugin.
 */

import { Plugin } from "@opencode/plugin/tui"

import { COMMANDCODE_RPC, REFRESH_EVENT, type RefreshNotice } from "./src/rpc.ts"

export default Plugin.define({
  id: "commandcode.tui",
  setup(context) {
    const rpc = context.client.rpc(COMMANDCODE_RPC)
    return rpc.events.on(REFRESH_EVENT, (event) => {
      const notice = event.data as RefreshNotice
      context.ui.toast.show({
        title: "Command Code",
        message: notice.message,
        variant: notice.variant,
        ...(notice.sessionID === undefined ? {} : { sessionID: notice.sessionID }),
      })
    })
  },
})
