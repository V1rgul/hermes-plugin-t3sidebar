#!/bin/sh
# Real Hermes Webapp in a container, for testing the plugin against the actual Desktop renderer and gateway with invented data only.
# Usage: tools/test-webapp/t3webapp.sh <setup|sync|seed|start|stop|login-url|browser|drive '<code>'|browser-reset|status|destroy|prune>
# Settings (environment): T3WEBAPP_RUNTIME (podman when installed, else docker), T3WEBAPP_NAME (t3demo, or t3demo-<worktree> in a linked worktree), T3WEBAPP_DIR (~/t3sidebar-demo, or ~/t3sidebar-demo-worktrees/<worktree>), T3WEBAPP_PORT (19120, or the first free port from 19121 in a linked worktree), T3WEBAPP_CDP_PORT (the test browser's, T3WEBAPP_PORT + 1000), T3WEBAPP_IMAGE (docker.io/nousresearch/hermes-agent:v0.23.0).
set -eu

RUNTIME=${T3WEBAPP_RUNTIME:-$(command -v podman >/dev/null 2>&1 && echo podman || echo docker)}
IMAGE=${T3WEBAPP_IMAGE:-docker.io/nousresearch/hermes-agent:v0.23.0}
HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$HERE/../.." && pwd)
PLUGIN=/opt/data/plugins/hermes-t3sidebar
ENABLER=/opt/data/desktop-plugins/t3webapp-enable-sidebar
# The shared container used from the main checkout; linked worktrees clone its data.
MAIN_NAME=t3demo
MAIN_DIR=$HOME/t3sidebar-demo
MAIN_PORT=19120

# A linked worktree has its own git dir apart from the common one: it gets its own container, so worktrees tested in parallel do not overwrite each other's plugin.
WORKTREE=
if [ "$(git -C "$REPO" rev-parse --path-format=absolute --git-dir 2>/dev/null)" != "$(git -C "$REPO" rev-parse --path-format=absolute --git-common-dir 2>/dev/null)" ]; then
	WORKTREE=$REPO
fi
if [ -n "$WORKTREE" ]; then
	SLUG=$(basename "$WORKTREE" | tr 'A-Z' 'a-z' | tr -c 'a-z0-9_.\n-' '-')
	NAME=${T3WEBAPP_NAME:-$MAIN_NAME-$SLUG}
	DIR=${T3WEBAPP_DIR:-$HOME/t3sidebar-demo-worktrees/$SLUG}
else
	NAME=${T3WEBAPP_NAME:-$MAIN_NAME}
	DIR=${T3WEBAPP_DIR:-$MAIN_DIR}
fi

in_box() { "$RUNTIME" exec --user hermes -e HERMES_HOME=/opt/data "$NAME" "$@"; }
exists() { "$RUNTIME" container inspect "$1" >/dev/null 2>&1; }
running() { [ "$("$RUNTIME" container inspect -f '{{.State.Running}}' "$1" 2>/dev/null)" = true ]; }
label() { "$RUNTIME" container inspect -f "{{index .Config.Labels \"$2\"}}" "$1" 2>/dev/null; }

# Free means published by no container, running or stopped, and refused by the host (curl exit 7), so neither another container nor a host service holds it.
port_free() {
	if "$RUNTIME" ps -a --format '{{.Ports}}' | grep -q ":$1->"; then return 1; fi
	rc=0
	curl -s -o /dev/null --max-time 1 "http://127.0.0.1:$1/" || rc=$?
	[ "$rc" -eq 7 ]
}

# An existing container keeps the port it was created with; a new worktree container takes the first free port after the shared one.
PORT=${T3WEBAPP_PORT:-$("$RUNTIME" container inspect -f '{{(index (index .HostConfig.PortBindings "9120/tcp") 0).HostPort}}' "$NAME" 2>/dev/null || true)}
if [ -z "$PORT" ] && [ -z "$WORKTREE" ]; then
	PORT=$MAIN_PORT
elif [ -z "$PORT" ]; then
	PORT=$((MAIN_PORT + 1))
	until port_free "$PORT"; do
		PORT=$((PORT + 1))
		[ "$PORT" -lt $((MAIN_PORT + 100)) ] || { echo "No free port below $((MAIN_PORT + 100))" >&2; exit 1; }
	done
fi

# The worktree's test browser: Playwright's Chromium with its profile inside the worktree (ignored by Git), on its own CDP port, so its sign-in and site storage last until browser-reset and worktrees run their browsers side by side.
BROWSER_DIR=$REPO/.t3webapp
PROFILE=$BROWSER_DIR/browser-profile
CDP_PORT=${T3WEBAPP_CDP_PORT:-$((PORT + 1000))}

# Hermes serves a non-loopback bind only behind a login, so the Webapp listens on loopback inside the container (port 9121) and this forwarder, started with it, exposes it on the published port 9120. The published port is itself loopback-only on the host, so the test Webapp needs no login. The forwarder runs as the container's hermes user, through the image's own privilege drop: Hermes lets only a connection from the server's own user redeem a launch link.
FORWARD='import asyncio
async def pipe(reader, writer):
	try:
		while data := await reader.read(65536):
			writer.write(data); await writer.drain()
	finally:
		writer.close()
async def client(reader, writer):
	try:
		upstream = await asyncio.open_connection("127.0.0.1", 9121)
	except OSError:
		writer.close(); return
	await asyncio.gather(pipe(reader, upstream[1]), pipe(upstream[0], writer), return_exceptions=True)
async def main():
	async with await asyncio.start_server(client, "0.0.0.0", 9120):
		await asyncio.Event().wait()
asyncio.run(main())'

# Root in a throwaway container is the host user (rootless Podman) or real root (Docker), so it can copy and delete the container user's files that the host user cannot read. Labelling is disabled so the source volume is not relabelled away from its own container.
as_root() { "$RUNTIME" run --rm --security-opt label=disable "$@"; }

# Waits for the Webapp to answer instead of a fixed delay: a first start takes longer than a restart, and the server answers 503 while it is still starting.
wait_ready() {
	i=0
	until code=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/") && [ "$code" -ge 200 ] && [ "$code" -lt 500 ]; do
		i=$((i + 1))
		[ "$i" -lt 90 ] || { echo "Webapp on port $PORT did not answer within 90 s" >&2; exit 1; }
		sleep 1
	done
}

# Keeps Limits readings under the plugin's 15-minute staleness threshold. A container restart ends the previous follower, so every (re)start calls this.
follow() {
	in_box test -f /opt/data/demo/seed_limits.py || return 0
	in_box pgrep -f "seed_limits.py follow" >/dev/null && return 0
	"$RUNTIME" exec -d --user hermes -e HERMES_HOME=/opt/data "$NAME" sh -c 'cd /opt/data/demo && exec /opt/hermes/.venv/bin/python seed_limits.py follow >> /opt/data/demo/limits-follow.log 2>&1' >/dev/null
}

# The pid file alone could name a recycled pid: the process must also hold this profile.
browser_pid() {
	pid=$(cat "$BROWSER_DIR/browser.pid" 2>/dev/null) || return 1
	{ tr '\0' ' ' < "/proc/$pid/cmdline"; } 2>/dev/null | grep -q -- "--user-data-dir=$PROFILE " && echo "$pid"
}

# Closed through CDP so Chromium writes its storage to the profile first: a signal can lose the last writes, such as a plugin switch. The signal is only the fallback.
stop_browser() {
	pid=$(browser_pid) || return 0
	drive 'const cdp = await context.browser().newBrowserCDPSession(); await cdp.send("Browser.close").catch(() => {});' >/dev/null 2>&1 || true
	i=0
	while kill -0 "$pid" 2>/dev/null && [ "$i" -lt 100 ]; do sleep 0.1; i=$((i + 1)); done
	! kill -0 "$pid" 2>/dev/null || kill "$pid"
	rm -f "$BROWSER_DIR/browser.pid"
}

drive() { T3WEBAPP_CDP_PORT=$CDP_PORT T3WEBAPP_SHOTS=$BROWSER_DIR/shots node "$HERE/drive.mjs" "$@"; }

ensure_running() {
	running "$NAME" || "$RUNTIME" start "$NAME" >/dev/null
	wait_ready
}

# Backend modules (dashboard routes, hooks, sampler) load at gateway start, so plugin changes need a restart.
restart_box() {
	"$RUNTIME" restart "$NAME" >/dev/null
	wait_ready
	follow
}

# Copies the working tree (uncommitted changes included, development files and the main checkout's linked worktrees excluded) over the installed plugin.
sync_plugin() {
	"$RUNTIME" exec "$NAME" rm -rf "$PLUGIN"
	"$RUNTIME" exec "$NAME" mkdir -p "$PLUGIN"
	tar -C "$REPO" --exclude=.git --exclude=.worktrees --exclude=.t3webapp --exclude=node_modules --exclude=__pycache__ --exclude=artifacts --exclude=harness --exclude=tests --exclude=docs --exclude=tools --exclude=AGENTS.md -cf - . \
		| "$RUNTIME" exec -i "$NAME" tar -C "$PLUGIN" -xf -
	"$RUNTIME" exec "$NAME" chown -R hermes:hermes "$PLUGIN"
	# A browser keeps the Desktop half's on/off choice, and a new browser profile starts with it off: this container-only plugin turns it on there (see enable-sidebar.js).
	"$RUNTIME" exec "$NAME" mkdir -p "$ENABLER"
	"$RUNTIME" cp "$HERE/enable-sidebar.js" "$NAME:$ENABLER/plugin.js"
	"$RUNTIME" exec "$NAME" chown -R hermes:hermes "$ENABLER"
}

# Points the Webapp at the forwarder's upstream: loopback port 9121, without a login. Runs on every create, so data cloned from a container made before this change is converted too.
loopback_config() {
	as_root -v "$DIR/data:/d" --entrypoint /opt/hermes/.venv/bin/python "$IMAGE" -c 'from ruamel.yaml import YAML
yaml, path = YAML(), "/d/config.yaml"
with open(path) as file:
	config = yaml.load(file) or {}
config.setdefault("webapp", {}).update(host="127.0.0.1", port=9121)
with open(path, "w") as file:
	yaml.dump(config, file)'
}

# Starts a worktree container from the shared container's seeded data and test-account login, so it needs neither seed nor an interactive login. A running shared container is paused during the copy so its databases are not caught mid-write.
clone_main_data() {
	paused=
	if running "$MAIN_NAME"; then "$RUNTIME" pause "$MAIN_NAME" >/dev/null && paused=1; fi
	rc=0
	as_root -v "$MAIN_DIR/data:/src:ro" -v "$DIR/data:/dst" --entrypoint sh "$IMAGE" -c 'cp -a /src/. /dst/ && sed -i "s|^\( *public_url:\).*|\1 \"http://127.0.0.1:$1\"|" /dst/config.yaml' sh "$PORT" || rc=$?
	[ -z "$paused" ] || "$RUNTIME" unpause "$MAIN_NAME" >/dev/null
	return "$rc"
}

create() {
	# Volume files are written before the first start: afterwards they belong to the container's mapped UID.
	mkdir -p "$DIR/data"
	"$RUNTIME" pull "$IMAGE"
	if [ -n "$WORKTREE" ] && [ -d "$MAIN_DIR/data" ] && [ -z "$(ls -A "$DIR/data")" ]; then
		echo "Cloning the data of $MAIN_NAME"
		clone_main_data
	elif ! as_root -v "$DIR/data:/d:ro" --entrypoint test "$IMAGE" -f /d/config.yaml; then
		# Checked from inside: once started, the data belongs to the container's user and the host user cannot see into it.
		printf 'webapp:\n  enabled: true\n  public_url: "http://127.0.0.1:%s"\ntelemetry:\n  shared_metrics:\n    enabled: false\n    send: false\n' "$PORT" > "$DIR/data/config.yaml"
	fi
	loopback_config
	# Loopback-only port and a volume of invented data: no real Hermes home, credentials or history ever enter the container. The labels let prune find the container once its worktree is gone, and mark it as served without a login.
	"$RUNTIME" run -d --name "$NAME" --label "t3webapp.worktree=$WORKTREE" --label "t3webapp.dir=$DIR" --label t3webapp.login=none -v "$DIR/data:/opt/data:Z" -p "127.0.0.1:$PORT:9120" \
		--entrypoint sh "$IMAGE" -c '/command/s6-setuidgid hermes /opt/hermes/.venv/bin/python -c "$1" & exec /opt/hermes/docker/entrypoint-dispatch.sh gateway run' sh "$FORWARD" >/dev/null
	wait_ready
}

# A worktree's browser is found by its profile path, which survives the pid file of a removed worktree.
stop_worktree_browser() { pkill -f -- "--user-data-dir=$1/.t3webapp/browser-profile" 2>/dev/null || true; }

# The same directory can be spelled several ways (a trailing slash, a symlink, a dot segment), so data directories are compared by their physical path.
canonical() { (cd "$1" 2>/dev/null && pwd -P) || printf '%s\n' "$1"; }
is_shared_dir() { [ "$(canonical "$1")" = "$(canonical "$MAIN_DIR")" ]; }

# Deletes only what create made (data, and the login file of containers made before logins were dropped, then the directory if nothing else is left), so a wrong directory never loses unrelated files. The shared data directory is never deleted, whichever container claims it.
remove_box() {
	! exists "$1" || "$RUNTIME" rm -f "$1" >/dev/null
	[ -n "$2" ] && [ -d "$2" ] || return 0
	! is_shared_dir "$2" || { echo "Kept $2: it is the shared container's data directory" >&2; return 0; }
	[ ! -d "$2/data" ] || as_root -v "$2:/d" --entrypoint rm "$IMAGE" -rf /d/data
	rm -f "$2/demo-login.env"
	rmdir "$2" 2>/dev/null || echo "Kept $2: it holds other files"
}

# Git has no hook on worktree removal, so containers whose worktree is gone are found by label and removed here, and at every setup.
prune() {
	for box in $("$RUNTIME" ps -a --filter label=t3webapp.worktree --format '{{.Names}}'); do
		wt=$(label "$box" t3webapp.worktree)
		[ -n "$wt" ] && [ ! -e "$wt/.git" ] || continue
		echo "Removing $box: worktree $wt is gone"
		stop_worktree_browser "$wt"
		remove_box "$box" "$(label "$box" t3webapp.dir)"
	done
}

case "${1:-}" in
setup)
	prune
	if exists "$NAME"; then
		owner=$(label "$NAME" t3webapp.worktree)
		[ "$owner" = "$WORKTREE" ] || { echo "Container $NAME belongs to ${owner:-the main checkout}; set T3WEBAPP_NAME and T3WEBAPP_DIR" >&2; exit 1; }
		if [ "$(label "$NAME" t3webapp.login)" != none ]; then
			# Made before logins were dropped: a container's command and environment are fixed, so it is recreated on the same data.
			echo "Recreating $NAME without a login; its data, test account included, is kept"
			"$RUNTIME" rm -f "$NAME" >/dev/null
			rm -f "$DIR/demo-login.env"
			create
		else
			# Reuses the container and its data: only the plugin is refreshed and re-enabled.
			echo "Reusing existing container $NAME"
			ensure_running
		fi
	else
		create
	fi
	sync_plugin
	in_box hermes plugins enable hermes-t3sidebar >/dev/null
	restart_box
	echo "Container $NAME is up on http://127.0.0.1:$PORT; sign a browser in with: $0 login-url"
	if ! in_box test -s /opt/data/auth.json; then
		cat <<EOF
For live turns, sign the container into a dedicated free Nous Portal account (never a personal one), then pick a free model:
  $RUNTIME exec -it --user hermes -e HERMES_HOME=/opt/data $NAME hermes auth add nous --no-browser --label demo
  $RUNTIME exec --user hermes -e HERMES_HOME=/opt/data $NAME hermes config set model.provider nous
  $RUNTIME exec --user hermes -e HERMES_HOME=/opt/data $NAME hermes config set model.default <free model id>
EOF
	fi
	in_box test -f /opt/data/demo/seed_limits.py || echo "Seed invented data with: $0 seed"
	;;
sync)
	ensure_running
	sync_plugin
	restart_box
	;;
seed)
	ensure_running
	"$RUNTIME" exec "$NAME" mkdir -p /opt/data/demo
	for f in seed_limits.py seed_usage.py bootstrap_workspace.sh; do "$RUNTIME" cp "$HERE/$f" "$NAME:/opt/data/demo/$f"; done
	"$RUNTIME" exec "$NAME" chown -R hermes:hermes /opt/data/demo
	# A running follower would keep writing into the history the backfill replaces.
	in_box pkill -f "seed_limits.py follow" || true
	in_box sh /opt/data/demo/bootstrap_workspace.sh
	in_box sh -c 'cd /opt/data/demo && /opt/hermes/.venv/bin/python seed_limits.py backfill && /opt/hermes/.venv/bin/python seed_usage.py'
	follow
	;;
start)
	ensure_running
	follow
	;;
stop)
	stop_browser
	"$RUNTIME" stop "$NAME"
	;;
login-url)
	# A loopback Webapp signs a browser in through a one-use link (valid 60 s) from `hermes webapp`, which names the container's own port.
	ensure_running
	in_box hermes webapp --no-open --skip-build | sed -n "s|^ *http://127.0.0.1:9121/|http://127.0.0.1:$PORT/|p"
	;;
browser)
	# No inactivity timeout: it runs until stop or browser-reset. Each start signs in again, which a still valid sign-in does not mind.
	ensure_running
	if ! browser_pid >/dev/null; then
		mkdir -p "$PROFILE" "$BROWSER_DIR/shots"
		chrome=$(node "$HERE/drive.mjs" --chromium)
		# No sandbox, like the browser smoke test: Ubuntu denies it to unprivileged users, and this browser only opens the loopback test Webapp.
		nohup "$chrome" --headless=new --no-sandbox --user-data-dir="$PROFILE" --remote-debugging-address=127.0.0.1 --remote-debugging-port="$CDP_PORT" \
			--window-size=1400,900 --no-first-run --no-default-browser-check about:blank > "$BROWSER_DIR/browser.log" 2>&1 &
		echo $! > "$BROWSER_DIR/browser.pid"
		i=0
		until curl -s -o /dev/null "http://127.0.0.1:$CDP_PORT/json/version"; do
			i=$((i + 1))
			[ "$i" -lt 100 ] || { echo "Test browser did not open CDP port $CDP_PORT; see $BROWSER_DIR/browser.log" >&2; exit 1; }
			sleep 0.1
		done
	fi
	link=$(in_box hermes webapp --no-open --skip-build | sed -n "s|^ *http://127.0.0.1:9121/|http://127.0.0.1:$PORT/|p")
	# Ready once the sidebar tab shows, or the profile holds an explicit Off; a blank profile first reloads once (enable-sidebar.js), which a read can straddle.
	T3WEBAPP_URL=$link drive 'await page.goto(process.env.T3WEBAPP_URL);
		const ready = () => JSON.parse(localStorage.getItem("hermes.desktop.pluginDecisions.v2") || "{}")["hermes-t3sidebar"] === false || [...document.querySelectorAll("[role=tab]")].some(tab => tab.textContent.trim() === "t3sidebar");
		for (let i = 0; i < 60; i++) {
			try { if (await page.evaluate(ready)) return page.url(); } catch (_) { /* the reload replaced the page mid-read */ }
			await page.waitForTimeout(500);
		}
		throw new Error("The Webapp did not show the sidebar within 30 s");' >/dev/null
	echo "Test browser signed in to http://127.0.0.1:$PORT (CDP port $CDP_PORT, profile $PROFILE); drive it with: $0 drive '<code>'"
	;;
drive)
	shift
	drive "$@"
	;;
browser-reset)
	# Only on request: the profile holds the browser's sign-in and site storage, including the plugin switch.
	stop_browser
	rm -rf -- "$PROFILE"
	echo "Erased $PROFILE; $0 browser starts a blank one"
	;;
status)
	"$RUNTIME" ps -a --filter "name=^$NAME\$" --format '{{.Names}} {{.Status}} {{.Ports}}'
	;;
destroy)
	# The shared container holds the test-account login made interactively, so this command never destroys it, nor its data directory under another container name.
	[ "$NAME" != "$MAIN_NAME" ] || { echo "Refusing to destroy the shared container $MAIN_NAME" >&2; exit 1; }
	! is_shared_dir "$DIR" || { echo "Refusing to destroy $NAME: its data directory $DIR is the shared container's; set T3WEBAPP_DIR" >&2; exit 1; }
	stop_browser
	rm -rf -- "$BROWSER_DIR"
	remove_box "$NAME" "$DIR"
	;;
prune)
	prune
	;;
*)
	sed -n '2,4p' "$0" | sed 's/^# //'
	exit 2
	;;
esac
