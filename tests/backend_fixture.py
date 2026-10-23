"""Loopback-only integration fixture; never used by the installed plugin."""
import importlib.util
from pathlib import Path
import socket
import sys
import tempfile
from contextlib import closing

from types import ModuleType
from hermes_state import SessionDB
from fastapi import FastAPI
import uvicorn

root = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("hermes_t3sidebar_integration_backend", root / "dashboard/plugin_api.py")
assert spec is not None and spec.loader is not None
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)

with tempfile.TemporaryDirectory(prefix="hermes-t3sidebar-http-") as directory:
	# Only this temporary native history is reachable by the native listing adapter.
	db_path = Path(directory) / "native.sqlite3"
	db = SessionDB(db_path)
	try:
		db.create_session("durable", "cli", cwd="/old-project")
		db.update_session_cwd("durable", "/old-project", git_branch="retained")
		for i in range(500):
			db.create_session(f"recent-{i}", "cli", cwd="/recent")
		db.create_session("external-archived", "cli", cwd="/archived-project")
		db.set_session_archived("external-archived", True, notify=False)
	finally:
		db.close()
	native = ModuleType("hermes_cli.web_server_sessions")
	def open_db(profile, *, read_only):
		assert profile == "default" and read_only is True
		return SessionDB(db_path, read_only=True)
	setattr(native, "_open_session_db_for_profile", open_db)
	sys.modules[native.__name__] = native
	async def runtime_reader(request, profile):
		# Injected fixture; native active_list itself is exercised in test_native_contracts.
		return {"sessions": [{"session_key": "recent-0", "status": "waiting"}]}
	completion_store = module.CompletionStore(Path(directory) / "state.sqlite3")
	# Real server-side ledger write before any HTTP/UI client exists.
	completion_store.record("durable", "fixture-offline-turn")
	app = FastAPI()
	@app.post("/fixture/complete")
	def complete(params: dict):
		# Test-only producer seam; production has no endpoint for creating Done.
		completion_store.record(params["session_id"], params["turn_id"])
		return {"ok": True}

	@app.post("/fixture/native-archive")
	def native_archive(params: dict):
		# Test-only RPC transport adapter: native lineage mutation in this scratch DB.
		assert params["profile"] == "default" and type(params["archived"]) is bool
		with closing(SessionDB(db_path)) as writer:
			assert writer.set_session_archived(params["session_id"], params["archived"], notify=False)
		return {"session_key": params["session_id"], "archived": params["archived"]}

	app.include_router(module.create_router(Path(directory) / "state.sqlite3", profile_reader=lambda: "default", runtime_reader=runtime_reader), prefix="/api/plugins/hermes-t3sidebar")
	with socket.socket() as listener:
		listener.bind(("127.0.0.1", 0))
		print(listener.getsockname()[1], flush=True)
		server = uvicorn.Server(uvicorn.Config(app, log_level="error", access_log=False))
		server.run(sockets=[listener])
