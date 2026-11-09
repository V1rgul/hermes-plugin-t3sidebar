#!/bin/sh
# Real Hermes Webapp in a container, for testing the plugin against the actual Desktop renderer and gateway with invented data only.
# Usage: tools/test-webapp/t3webapp.sh <setup|sync|seed|start|stop|login-url|status|destroy|prune>
# Settings (environment): T3WEBAPP_RUNTIME (podman when installed, else docker), T3WEBAPP_NAME (t3demo, or t3demo-<worktree> in a linked worktree), T3WEBAPP_DIR (~/t3sidebar-demo, or ~/t3sidebar-demo-worktrees/<worktree>), T3WEBAPP_PORT (19120, or the first free port from 19121 in a linked worktree), T3WEBAPP_IMAGE (docker.io/nousresearch/hermes-agent:v0.23.0).
set -eu

RUNTIME=${T3WEBAPP_RUNTIME:-$(command -v podman >/dev/null 2>&1 && echo podman || echo docker)}
IMAGE=${T3WEBAPP_IMAGE:-docker.io/nousresearch/hermes-agent:v0.23.0}
HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$HERE/../.." && pwd)
PLUGIN=/opt/data/plugins/hermes-t3sidebar
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
	tar -C "$REPO" --exclude=.git --exclude=.worktrees --exclude=node_modules --exclude=__pycache__ --exclude=artifacts --exclude=harness --exclude=tests --exclude=docs --exclude=tools --exclude=AGENTS.md -cf - . \
		| "$RUNTIME" exec -i "$NAME" tar -C "$PLUGIN" -xf -
	"$RUNTIME" exec "$NAME" chown -R hermes:hermes "$PLUGIN"
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
	if [ ! -f "$DIR/demo-login.env" ]; then
		(umask 077 && printf 'HERMES_DASHBOARD_BASIC_AUTH_USERNAME=demo\nHERMES_DASHBOARD_BASIC_AUTH_PASSWORD=%s\n' "$(head -c 24 /dev/urandom | base64 | tr -dc 'A-Za-z0-9')" > "$DIR/demo-login.env")
	fi
	"$RUNTIME" pull "$IMAGE"
	if [ -n "$WORKTREE" ] && [ -d "$MAIN_DIR/data" ] && [ -z "$(ls -A "$DIR/data")" ]; then
		echo "Cloning the data of $MAIN_NAME"
		clone_main_data
	elif [ ! -f "$DIR/data/config.yaml" ]; then
		printf 'webapp:\n  enabled: true\n  host: 0.0.0.0\n  port: 9120\n  public_url: "http://127.0.0.1:%s"\ntelemetry:\n  shared_metrics:\n    enabled: false\n    send: false\n' "$PORT" > "$DIR/data/config.yaml"
	fi
	# Loopback-only port and a volume of invented data: no real Hermes home, credentials or history ever enter the container. The labels let prune find the container once its worktree is gone.
	"$RUNTIME" run -d --name "$NAME" --label "t3webapp.worktree=$WORKTREE" --label "t3webapp.dir=$DIR" --env-file "$DIR/demo-login.env" -v "$DIR/data:/opt/data:Z" -p "127.0.0.1:$PORT:9120" "$IMAGE" gateway run >/dev/null
	wait_ready
}

# Deletes only what create made (data and login, then the directory if nothing else is left), so a wrong directory never loses unrelated files.
remove_box() {
	! exists "$1" || "$RUNTIME" rm -f "$1" >/dev/null
	[ -n "$2" ] && [ -d "$2" ] || return 0
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
		remove_box "$box" "$(label "$box" t3webapp.dir)"
	done
}

case "${1:-}" in
setup)
	prune
	if exists "$NAME"; then
		owner=$(label "$NAME" t3webapp.worktree)
		[ "$owner" = "$WORKTREE" ] || { echo "Container $NAME belongs to ${owner:-the main checkout}; set T3WEBAPP_NAME and T3WEBAPP_DIR" >&2; exit 1; }
		# Reuses the container and its data: only the plugin is refreshed and re-enabled.
		echo "Reusing existing container $NAME"
		ensure_running
	else
		create
	fi
	sync_plugin
	in_box hermes plugins enable hermes-t3sidebar >/dev/null
	restart_box
	echo "Container $NAME is up on http://127.0.0.1:$PORT (login in $DIR/demo-login.env)."
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
	"$RUNTIME" stop "$NAME"
	;;
login-url)
	echo "http://127.0.0.1:$PORT  (user and password: $DIR/demo-login.env)"
	;;
status)
	"$RUNTIME" ps -a --filter "name=^$NAME\$" --format '{{.Names}} {{.Status}} {{.Ports}}'
	;;
destroy)
	# The shared container holds the test-account login made interactively, so this command never destroys it.
	[ "$NAME" != "$MAIN_NAME" ] || { echo "Refusing to destroy the shared container $MAIN_NAME" >&2; exit 1; }
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
