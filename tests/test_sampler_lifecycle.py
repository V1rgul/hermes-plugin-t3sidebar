"""Real plugin registration and file-loaded HTTP sampler share unload ownership; scratch homes only."""
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
import contextvars
import importlib.util
from pathlib import Path
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch

from hermes_constants import reset_hermes_home_override, set_hermes_home_override
from hermes_cli.plugins import PluginContext, PluginManager, PluginManifest
from test_usage_routes import backend

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("t3sidebar_sampler_lifecycle_test", ROOT / "__init__.py", submodule_search_locations=[str(ROOT)])
assert SPEC is not None and SPEC.loader is not None
plugin = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = plugin
SPEC.loader.exec_module(plugin)


class SamplerLifecycleTests(unittest.TestCase):
	def setUp(self):
		self.temp = tempfile.TemporaryDirectory(prefix="t3-sampler-lifecycle-")
		self.addCleanup(self.temp.cleanup)
		self.home = Path(self.temp.name) / "first"
		self.home.mkdir()
		self.sampler_type = backend.usage_limits.LimitsSampler
		factory = patch.object(backend.usage_limits, "LimitsSampler", side_effect=self.make_sampler)
		factory.start()
		self.addCleanup(factory.stop)

	def make_sampler(self, store, **kwargs):
		# Never let a lifecycle regression call the real provider collector.
		sampler = self.sampler_type(store, first_delay_s=60, collector=lambda: [], **kwargs)
		self.addCleanup(sampler.stop)
		return sampler

	@contextmanager
	def scope(self, home=None):
		token = set_hermes_home_override(home or self.home)
		try:
			yield
		finally:
			reset_hermes_home_override(token)

	def register(self, home=None):
		with self.scope(home):
			manager = PluginManager(scope_key=str(home or self.home))
			manifest = PluginManifest(name="hermes-t3sidebar", path=str(ROOT))
			ctx = PluginContext(manifest, manager)
			plugin.register(ctx)
		def unload():
			manager.unload(manifest)
		self.addCleanup(unload)
		return unload

	def test_unload_stops_file_loaded_api_sampler_and_prevents_late_restart(self):
		unload = self.register()
		with self.scope():
			sampler = backend.ensure_limits_sampler()
			self.assertIs(backend.ensure_limits_sampler(), sampler)
		self.assertTrue(sampler._thread.is_alive())
		unload()
		self.assertFalse(sampler._thread.is_alive())
		with self.scope():
			self.assertIsNone(backend.ensure_limits_sampler())
		unload()

	def test_unload_is_profile_exact_and_old_callback_cannot_stop_reloaded_owner(self):
		other = Path(self.temp.name) / "second"
		other.mkdir()
		unload_first = self.register()
		unload_second = self.register(other)
		with self.scope():
			first = backend.ensure_limits_sampler()
		with self.scope(other):
			second = backend.ensure_limits_sampler()
		unload_first()
		self.assertFalse(first._thread.is_alive())
		self.assertTrue(second._thread.is_alive())
		unload_reload = self.register()
		with self.scope():
			reloaded = backend.ensure_limits_sampler()
		self.assertIsNot(reloaded, first)
		unload_first()
		self.assertTrue(reloaded._thread.is_alive())
		unload_reload()
		unload_second()
		self.assertFalse(reloaded._thread.is_alive())
		self.assertFalse(second._thread.is_alive())

	def test_unload_waits_for_admitted_start_and_then_stops_it(self):
		unload = self.register()
		entered, release, closing = threading.Event(), threading.Event(), threading.Event()
		native_start = self.sampler_type.start
		def gated_start(sampler):
			entered.set()
			if not release.wait(5):
				raise TimeoutError("test start gate")
			return native_start(sampler)
		def close():
			closing.set()
			unload()
		with ThreadPoolExecutor(max_workers=2) as pool, patch.object(self.sampler_type, "start", gated_start):
			with self.scope():
				starting = pool.submit(contextvars.copy_context().run, backend.ensure_limits_sampler)
			try:
				self.assertTrue(entered.wait(5))
				stopping = pool.submit(close)
				self.assertTrue(closing.wait(5))
			finally:
				release.set()
			sampler = starting.result(timeout=5)
			stopping.result(timeout=5)
		self.assertFalse(sampler._thread.is_alive())
		with self.scope():
			self.assertIsNone(backend.ensure_limits_sampler())
