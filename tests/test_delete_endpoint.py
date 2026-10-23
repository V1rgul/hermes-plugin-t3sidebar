"""Plugin delete delegates to installed native HTTP against isolated synthetic homes.

Auth/profile selection and owner discovery are injected; native HTTP, offline
ownership reservation, SQLite mutation/receipts, guards and cleanup are real.
No real gateway is discovered, no real credentials or history are accessed.
"""
import asyncio
from contextlib import closing, contextmanager
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, patch

from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient
from hermes_constants import get_hermes_home, reset_hermes_home_override, set_hermes_home_override
from hermes_state import SessionDB
import hermes_state_runtime as runtime
from gateway.session_contract import Principal
from hermes_cli.web_server_dashboard import _plugin_route_secret_scope
from test_backend import backend

PREFIX = "/api/plugins/hermes-t3sidebar"
BODY = {"request_id": "confirmed-delete", "expected_revision": 0, "expected_generation": 0}


class DeleteEndpoint(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="t3-native-delete-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.homes = {name: self.root / name for name in ("exact-profile", "other-profile")}
        for home in self.homes.values():
            home.mkdir()
            with closing(SessionDB(home / "state.db")) as db:
                db.create_session("target", "desktop", system_prompt="PRIVATE FIXTURE")
                db.create_session("target-longer", "desktop")
        self.home = self.homes["exact-profile"]
        self.profile = "exact-profile"
        self.subject = SimpleNamespace(user_id="fixture-user", provider="fixture", issuer="fixture")
        self.native_grant = None
        self.hosted = None

        self.start_patch("hermes_cli.web_server_profiles._config_profile_scope", self.scope)
        self.start_patch("hermes_cli.web_server_profiles._is_current_profile", return_value=True)
        self.start_patch("hermes_cli.web_server_plugin_profiles.in_process_router_refused", return_value=False)
        self.start_patch("hermes_constants.profile_name_for_home", side_effect=lambda home: Path(home).name)
        self.start_patch("hermes_cli.web_server_cron._cron_profile_home", side_effect=self.resolve)
        self.start_patch("hermes_cli.web_routers.sessions._cron_profile_home", side_effect=self.resolve)
        self.owner_forward = self.start_patch("hermes_cli.web_server_sessions._mutate_via_gateway_owner", new=AsyncMock(return_value=None))
        self.emit = self.start_patch("hermes_state_common.emit_session_deleted")
        self.app = FastAPI()

        @self.app.middleware("http")
        async def identity(request, call_next):
            if self.subject is not None:
                request.state.session = self.subject
            if self.native_grant is not None:
                request.state.native_http_principal = self.native_grant
            if self.hosted is not None:
                request.state.hosted_http_authenticated = self.hosted
            return await call_next(request)

        self.app.include_router(backend.create_router(), prefix=PREFIX,
                                dependencies=[Depends(_plugin_route_secret_scope)])
        self.client = TestClient(self.app)
        self.addCleanup(self.client.close)

    def start_patch(self, *args, **kwargs):
        p = patch(*args, **kwargs)
        value = p.start()
        self.addCleanup(p.stop)
        return value

    def resolve(self, profile):
        return profile, self.homes[profile]

    @contextmanager
    def scope(self, profile):
        token = set_hermes_home_override(self.homes[profile or self.profile])
        try:
            yield
        finally:
            reset_hermes_home_override(token)

    def post(self, sid="target", body=None, query=None):
        return self.client.post(f"{PREFIX}/sessions/{sid}/delete?{query or 'profile=' + self.profile}",
                                json=BODY if body is None else body)

    def exists(self, sid, home=None):
        with closing(SessionDB((home or self.home) / "state.db", read_only=True)) as db:
            return db.get_session(sid) is not None

    def test_native_http_delete_cleanup_receipt_exact_retry_and_profile_collision(self):
        files = self.home / "sessions"
        files.mkdir()
        names = ("target.json", "target.jsonl", "session_target.json", "request_dump_target_turn.json")
        for name in (*names, "target-longer.jsonl"):
            (files / name).write_text("PRIVATE FIXTURE", encoding="utf-8")
        response = self.post(query="profile=exact-profile&profile=exact-profile")
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.headers["cache-control"], "no-store")
        expected = {"ok": True, "profile": self.profile, "session_id": "target", "request_id": BODY["request_id"],
                    "operation": "delete", "deleted_ids": ["target"], "already_absent": False,
                    "verified_absent": True, "revision": 1, "execution_generation": 0}
        self.assertEqual(response.json(), expected)
        self.assertEqual(self.post().json(), expected)
        self.assertEqual(self.emit.call_count, 1)
        self.assertFalse(self.exists("target"))
        self.assertTrue(self.exists("target-longer"))
        self.assertTrue(self.exists("target", self.homes["other-profile"]))
        self.assertFalse(any((files / name).exists() for name in names))
        self.assertTrue((files / "target-longer.jsonl").exists())
        # Core's durable receipt rejects a changed retry digest, even after deletion.
        changed = self.post(body=BODY | {"expected_generation": 1})
        self.assertEqual(changed.status_code, 409, changed.text)
        self.assertEqual(changed.json()["detail"], "admission_conflict")
        self.assertFalse((self.home / "plugin-data").exists())

    def test_absent_is_exact_idempotent_success_not_substring_resolution(self):
        response = self.post("targ")
        self.assertEqual(response.status_code, 200, response.text)
        value = response.json()
        self.assertTrue(value["already_absent"])
        self.assertEqual(value["deleted_ids"], ["targ"])
        self.assertNotIn("revision", value)
        self.assertTrue(self.exists("target"))
        self.assertTrue(self.exists("target-longer"))

    def test_revision_and_generation_refusals_do_not_delete(self):
        for body, reason in ((BODY | {"expected_revision": 1}, "revision_conflict"),
                             (BODY | {"expected_generation": 1}, "stale_generation")):
            with self.subTest(reason=reason):
                response = self.post(body=body)
                self.assertEqual(response.status_code, 409, response.text)
                self.assertEqual(response.json()["detail"], reason)
                self.assertTrue(self.exists("target"))
        self.emit.assert_not_called()

    def test_native_lineage_delete_takes_compression_and_delegates_not_branch(self):
        with closing(SessionDB(self.home / "state.db")) as db:
            db.end_session("target", "compression")
            db.create_session("tip", "desktop", parent_session_id="target")
            db.create_session("delegate", "cli", parent_session_id="tip", model_config={"_delegate_from": "tip"})
            db.create_session("branch", "desktop", parent_session_id="target", model_config={"_branched_from": "target"})
        response = self.post("tip")
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(set(response.json()["deleted_ids"]), {"target", "tip", "delegate"})
        for sid in response.json()["deleted_ids"]:
            self.assertFalse(self.exists(sid))
        self.assertTrue(self.exists("branch"))

    def test_busy_descendant_admission_worker_and_compression_are_native_refusals(self):
        for kind in ("queued", "started", "unknown", "worker", "compression", "lease"):
            sid, child = "busy-" + kind, "child-" + kind
            with closing(SessionDB(self.home / "state.db")) as db:
                db.create_session(sid, "desktop")
                db.create_session(child, "cli", parent_session_id=sid, model_config={"_delegate_from": sid})
                epoch = runtime.begin_runtime_epoch(db, instance_id="scratch-owner")
                if kind == "compression":
                    self.assertTrue(db.try_acquire_compression_lock(child, "fixture-holder"))
                elif kind == "lease":
                    self.assertTrue(db.try_acquire_session_turn_lease(child, "fixture-holder"))
                elif kind == "worker":
                    runtime.register_worker_execution(db, epoch=epoch, execution_id="fixture-worker", session_id=child,
                                                      generation=0, kind="child", adoption_secret="synthetic")
                else:
                    runtime.admit_session_input(db, epoch=epoch, principal_id="fixture", session_id=child,
                                                request_id="input-" + kind, payload={"text": "synthetic"})
                    if kind in ("started", "unknown"):
                        runtime.claim_session_input(db, epoch=epoch, session_id=child)
                    if kind == "unknown":
                        epoch = runtime.begin_runtime_epoch(db, instance_id="scratch-replacement")
                        runtime.recover_session_inputs(db, epoch=epoch)
            response = self.post(sid)
            self.assertEqual(response.status_code, 409, response.text)
            self.assertIn(response.json()["detail"], {"session_busy", "unknown_execution"})
            self.assertTrue(self.exists(sid))
            self.assertTrue(self.exists(child))
        self.emit.assert_not_called()

    def test_unknown_owner_failure_remains_retryable_no_legacy_fallback(self):
        from fastapi import HTTPException
        self.owner_forward.side_effect = HTTPException(503, "owner_unreachable")
        response = self.post()
        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.json()["detail"], "owner_unreachable")
        self.assertTrue(self.exists("target"))
        self.emit.assert_not_called()

    def test_ambiguous_post_commit_read_failure_exact_retry_replays_receipt(self):
        with patch.object(backend, "native_delete_snapshot", side_effect=OSError("synthetic read failure")):
            response = self.post()
        self.assertEqual(response.status_code, 503)
        self.assertFalse(self.exists("target"))
        retry = self.post()
        self.assertEqual(retry.status_code, 200, retry.text)
        self.assertFalse(retry.json()["already_absent"])
        self.assertEqual(retry.json()["revision"], 1)
        self.assertEqual(self.emit.call_count, 1)

    def test_invalid_native_receipt_and_existing_readback_cannot_claim_success(self):
        receipt = {"ok": True, "session_id": "target", "operation": "delete", "revision": 1,
                   "execution_generation": 0, "deleted_ids": ["target"]}
        for change in ({"session_id": "target-longer"}, {"operation": "sidebar"}, {"revision": 2},
                       {"execution_generation": 1}, {"deleted_ids": []}, {"deleted_ids": ["../target"]}):
            with self.subTest(change=change), patch("hermes_cli.web_routers.sessions.delete_session_endpoint", new=AsyncMock(return_value=receipt | change)):
                response = self.post()
                self.assertEqual(response.status_code, 503)
                self.assertEqual(response.json()["detail"], "native_delete_receipt_invalid")
        with patch("hermes_cli.web_routers.sessions.delete_session_endpoint", new=AsyncMock(return_value=receipt)):
            response = self.post()
            self.assertEqual(response.status_code, 503)
            self.assertEqual(response.json()["detail"], "native_delete_verification_failed")
        self.assertTrue(self.exists("target"))

    def test_strict_payload_and_repeated_profile_assertions_refuse_before_mutation(self):
        bodies = [{}, BODY | {"expected_revision": True}, BODY | {"expected_generation": "0"},
                  BODY | {"expected_generation": None}, BODY | {"expected_generation": -1},
                  BODY | {"request_id": " "}, BODY | {"request_id": "x" * 257}, BODY | {"profile": "other-profile"},
                  BODY | {"operation": "delete"}, BODY | {"payload": {}}]
        for body in bodies:
            with self.subTest(body=body):
                self.assertEqual(self.post(body=body).status_code, 422)
        for query in ("profile=", "profile=exact-profile&profile=other-profile", "profile=other-profile&profile=exact-profile", "profile=exact-profile&unknown=1"):
            with self.subTest(query=query):
                self.assertEqual(self.post(query=query).status_code, 422)
        self.owner_forward.assert_not_called()
        self.assertTrue(self.exists("target"))

    def test_missing_actor_hosted_admission_foreign_grant_and_store_fail_closed(self):
        self.subject = None
        response = self.post()
        self.assertEqual(response.status_code, 401, response.text)
        self.subject = SimpleNamespace(user_id="fixture", provider="fixture", issuer="fixture")
        for value in (True, False):
            self.hosted = value
            response = self.post()
            self.assertEqual(response.status_code, 503)
            self.assertEqual(response.json()["detail"], "native_delete_context_unavailable")
        self.hosted = None
        self.native_grant = {"subject": "fixture", "profile_id": str(self.homes["other-profile"])}
        self.assertEqual(self.post().status_code, 403)
        self.native_grant = None
        with patch("hermes_cli.web_server_sessions._session_db_path_for_profile", return_value=self.homes["other-profile"] / "state.db"):
            self.assertEqual(self.post().status_code, 403)
        self.owner_forward.assert_not_called()
        self.assertTrue(self.exists("target"))

    def test_foreign_actor_and_readonly_actor_refuse_before_native_delegate(self):
        for actor in (Principal("fixture", str(self.homes["other-profile"]), frozenset({"session:control"}), "http"),
                      Principal("fixture", str(self.home), frozenset({"session:read"}), "http")):
            with patch("hermes_cli.web_server_sessions._session_mutation_context", return_value=(None, actor)):
                self.assertEqual(self.post().status_code, 403)
        self.owner_forward.assert_not_called()


    def test_authority_backed_deletion_uses_native_owner_not_offline_writer(self):
        from gateway.session_authority import LiveSession, SessionAuthority
        with closing(SessionDB(self.home / "state.db")) as db:
            epoch = runtime.begin_runtime_epoch(db, instance_id="scratch-owner")
            authority = SessionAuthority(SimpleNamespace(_draining=False), profile_id=str(self.home),
                                         instance_id="scratch-owner", db=db, epoch=epoch)
            authority.sessions["target"] = LiveSession(None, "fixture-route")
            self.app.state.session_authority = authority
            with patch("hermes_cli.web_server_sessions._mutate_offline_store", side_effect=AssertionError("no second writer")):
                response = self.post()
            self.assertEqual(response.status_code, 200, response.text)
            self.assertTrue(response.json()["verified_absent"])
            self.assertIsNone(db.get_session("target"))
            self.assertNotIn("target", authority.sessions)
        self.owner_forward.assert_not_called()

    def test_cancelled_delegate_propagates_without_fallback(self):
        request = SimpleNamespace(state=SimpleNamespace(), app=self.app)
        actor = Principal("fixture", str(self.home), frozenset({"session:control"}), "http")
        with self.scope(self.profile), patch("hermes_cli.web_server_sessions._session_mutation_context", return_value=(None, actor)), patch(
                "hermes_cli.web_routers.sessions.delete_session_endpoint", new=AsyncMock(side_effect=asyncio.CancelledError)):
            with self.assertRaises(asyncio.CancelledError):
                asyncio.run(backend.native_delete(request, self.profile, "target", backend.SessionDelete(**BODY)))
        self.assertTrue(self.exists("target"))
        self.owner_forward.assert_not_called()

    def test_workspace_is_exact_readonly_allowlisted_and_profile_qualified(self):
        from hermes_cli import projects_db
        with closing(projects_db.connect(self.home / "projects.db")) as catalog:
            project = projects_db.create_project(catalog, name="Chosen project", folders=["/chosen"], icon="tree", color="#123456")
        with closing(SessionDB(self.home / "state.db")) as db:
            db.update_session_cwd("target", "/chosen/sub", git_branch="feature", git_repo_root="/chosen")
            db.end_session("target", "compression")
            db.create_session("tip", "desktop", parent_session_id="target", cwd="/different-tip")
            db.set_session_title("target", "title-alias")
            # The legacy move's exact-row native write does not move the tip.
            db.update_session_cwd("target", "/chosen/sub", "feature", "/chosen", replace_git_meta=True)
            projected = next(row for row in db.list_sessions_rich(limit=20, compact_rows=True)
                             if row.get("_lineage_root_id") == "target")
            self.assertEqual(projected["cwd"], "/different-tip")
        before = {path: path.read_bytes() for path in (self.home / "state.db", self.home / "projects.db")}
        with patch.object(SessionDB, "get_session", side_effect=AssertionError("no full session read")):
            response = self.client.get(f"{PREFIX}/sessions/target/workspace?profile=exact-profile&profile=exact-profile")
            self.assertEqual(response.status_code, 200, response.text)
            self.assertEqual(response.headers["cache-control"], "no-store")
            self.assertEqual(response.json(), {"profile": self.profile, "id": "target", "cwd": "/chosen/sub",
                             "git_branch": "feature", "git_repo_root": "/chosen",
                             "project": {"id": project, "name": "Chosen project", "icon": "tree", "color": "#123456", "cwd": "/chosen"}})
            tip = self.client.get(f"{PREFIX}/sessions/tip/workspace?profile=exact-profile").json()
            self.assertEqual(tip["cwd"], "/different-tip")
            for alias in ("targ", "title-alias", "missing"):
                self.assertEqual(self.client.get(f"{PREFIX}/sessions/{alias}/workspace?profile=exact-profile").status_code, 404)
        foreign = self.client.get(f"{PREFIX}/sessions/target/workspace?profile=other-profile")
        self.assertEqual(foreign.status_code, 200, foreign.text)
        self.assertIsNone(foreign.json()["cwd"])
        for query in ("profile=", "profile=exact-profile&profile=other-profile", "profile=other-profile&profile=exact-profile", "profile=exact-profile&extra=1"):
            self.assertEqual(self.client.get(f"{PREFIX}/sessions/target/workspace?{query}").status_code, 422)
        for path, data in before.items():
            self.assertEqual(path.read_bytes(), data)
        self.assertFalse((self.home / "plugin-data").exists())

    def test_archived_pin_snooze_refused_without_metadata_writes_or_native_restore(self):
        metadata = self.home / "plugin-data/hermes-t3sidebar/state.sqlite3"
        url = f"{PREFIX}/sessions/target?profile=exact-profile"
        with closing(SessionDB(self.home / "state.db")) as db:
            db.set_session_archived("target", True, notify=False)
        for body in ({"action": "pin"}, {"action": "snooze", "wake_at": 4000000000}):
            response = self.client.post(url, json=body)
            self.assertEqual(response.status_code, 409, response.text)
            self.assertEqual(response.json()["detail"], "native_session_archived")
            self.assertFalse(metadata.exists())
        # Existing organization and completion records stay byte-identical on refusal.
        store = backend.HermesT3SidebarStore(metadata, lambda: 1000)
        store.mutate("target", backend.SessionAction(action="pin"))
        store.mutate("other", backend.SessionAction(action="snooze", wake_at=1001))
        backend.CompletionStore(metadata, lambda: 1000).record("target", "turn")
        before = metadata.read_bytes()
        for body in ({"action": "pin"}, {"action": "snooze", "wake_at": 4000000000}):
            self.assertEqual(self.client.post(url, json=body).status_code, 409)
            self.assertEqual(metadata.read_bytes(), before)
        for body in ({"action": "unpin"}, {"action": "restore"}, {"action": "ack_wake", "woke_at": 1001},
                     {"action": "ack_done", "done_token": "turn"}):
            response = self.client.post(url, json=body)
            self.assertEqual(response.status_code, 200, response.text)
            with closing(SessionDB(self.home / "state.db", read_only=True)) as db:
                row = db.get_session("target")
                assert row is not None
                self.assertTrue(row["archived"])
        # Same durable ID in another profile is active and may still be pinned.
        response = self.client.post(f"{PREFIX}/sessions/target?profile=other-profile", json={"action": "pin"})
        self.assertEqual(response.status_code, 200, response.text)

    def test_archive_guard_failure_and_mixed_queries_never_create_metadata(self):
        for sid in ("targ", "missing"):
            response = self.client.post(f"{PREFIX}/sessions/{sid}?profile=exact-profile", json={"action": "pin"})
            self.assertEqual(response.status_code, 404)
        with patch.object(backend, "native_archive", side_effect=OSError("synthetic failure")):
            response = self.client.post(f"{PREFIX}/sessions/target?profile=exact-profile", json={"action": "pin"})
            self.assertEqual(response.status_code, 503)
        for query in ("profile=exact-profile&profile=other-profile", "profile=exact-profile&other=1"):
            response = self.client.post(f"{PREFIX}/sessions/target?{query}", json={"action": "pin"})
            self.assertEqual(response.status_code, 422)
        self.assertFalse((self.home / "plugin-data").exists())


if __name__ == "__main__":
    unittest.main()
