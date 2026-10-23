# Installation

[Back to the README](../README.md) · [Sidebar behavior and limitations](behavior.md)

## Install from Git

1. In Hermes Desktop, open **Capabilities → Plugins → Install from Git**.
2. Enter `https://github.com/V1rgul/hermes-plugin-t3sidebar`.
3. Select **Agent plugin** and **Desktop UI**. If the backend companion is already installed, select **Desktop UI** only.
4. Enable the agent companion in the profile you want to use and turn on the Desktop UI switch.
5. If the new backend API routes are not loaded, restart the backend serving Desktop when an interruption is acceptable. A Desktop UI file update normally hot-loads without a client restart.
6. Open the **t3sidebar** pane and hide the built-in **Sessions** pane through Hermes's normal layout controls. You can move or resize the new pane like any other.

**Remote backend:** the companion runs on the server, but the Desktop UI must be installed on the computer running Hermes Desktop. A server checkout alone does not install the UI on your local computer. See the [Hermes Desktop plugin documentation](https://hermes-agent.nousresearch.com/docs/developer-guide/desktop-plugin-sdk).

Installing files, enabling the plugin, loading backend routes and seeing the pane are separate steps. This repository does not restart services or change configuration automatically.

## Install a local checkout

1. Put the package in the backend's profile-local `plugins/hermes-t3sidebar/` and enable it through Hermes's native plugin management.
2. Restart the backend serving Desktop, if needed to load the new API routes, when an interruption is acceptable.
3. On the computer running Desktop, open **Capabilities → Plugins → Open folder**. Copy the contents of this repository's `desktop/` into `<that folder>/hermes-t3sidebar/` and enable the Desktop UI.
4. The file watcher normally loads the UI automatically. If it does not, use **Reload desktop plugins** from the command palette.
5. Open **t3sidebar** and hide the built-in **Sessions** pane using the normal layout controls.

## Upgrading from Session Flow

The plugin was previously named **Session Flow** (`session-flow`). Remove the old agent and Desktop installations and enabled entries through Hermes's plugin management before installing `hermes-t3sidebar`, so both versions do not run together.

Existing `plugin-data/session-flow/state.sqlite3` metadata is not automatically migrated or deleted. The renamed plugin uses `plugin-data/hermes-t3sidebar/state.sqlite3`; native conversation history is unchanged. See the [rename verification](rename-verification.md) for the original migration boundary.
