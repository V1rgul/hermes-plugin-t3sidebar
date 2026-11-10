// Installed by t3webapp.sh into the test container's desktop-plugins only. Hermes keeps each Desktop plugin's on/off choice in the browser, and an installed package's Desktop half starts off, so every new browser profile would need the switch clicked again. This folder carries no package marker, so it loads by default and turns hermes-t3sidebar on in a browser that has not chosen yet; an explicit Off is kept.
const KEY = 'hermes.desktop.pluginDecisions.v2', ID = 'hermes-t3sidebar';
const decisions = () => JSON.parse(window.localStorage.getItem(KEY) || '{}');

export default {
	id: 't3webapp-enable-sidebar', name: 't3webapp-enable-sidebar',
	register() {
		try {
			if (ID in decisions()) return;
			window.localStorage.setItem(KEY, JSON.stringify({ ...decisions(), [ID]: true }));
			// The app read the choices when it started: one reload loads the sidebar. Reading the choice back first means a browser that refuses to store it never loops.
			if (decisions()[ID] === true) window.location.reload();
		} catch (_) { /* No storage: the switch stays a manual click. */ }
	}
};
