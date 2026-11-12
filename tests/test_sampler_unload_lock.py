"""Unloading the Limits sampler waits for its thread without holding the lock every /runtime poll takes to start sampling."""

from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import tempfile
import threading
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from test_backend import backend


limits = backend.usage_limits
# Captured before any test replaces the module attribute with its factory.
NATIVE_SAMPLER = limits.LimitsSampler


class Context:
	def __init__(self):
		self.unloads = []

	def on_unload(self, callback):
		self.unloads.append(callback)


class SamplerUnloadLock(unittest.TestCase):
	def setUp(self):
		self.temp = tempfile.TemporaryDirectory(prefix="t3-sampler-unload-")
		self.addCleanup(self.temp.cleanup)
		home = Path(self.temp.name)
		for patcher in (patch.object(limits, "_default_home", return_value=home),
				patch.object(limits, "LimitsSampler", side_effect=self.make_sampler)):
			patcher.start()
			self.addCleanup(patcher.stop)
		self.entered, self.release = threading.Event(), threading.Event()
		self.addCleanup(self.release.set)
		self.store = SimpleNamespace(record=lambda readings, checked_at: 0, write_status=lambda status: None)
		self.key = (limits.os.getpid(), limits._home_key(home))

	def make_sampler(self, store, **kwargs):
		# A tick that stays in its collector until the test releases it, like a slow provider read.
		def collector():
			self.entered.set()
			self.release.wait(10)
			return []
		sampler = NATIVE_SAMPLER(store, first_delay_s=0, collector=collector, **kwargs)
		self.addCleanup(sampler.stop)
		return sampler

	def register(self):
		context = Context()
		limits.register_limits_sampler(context)
		self.addCleanup(lambda: [callback() for callback in context.unloads])
		return context

	def test_unload_joins_a_busy_sampler_outside_the_owners_lock(self):
		context = self.register()
		sampler = limits.start_limits_sampler(self.store)
		self.assertTrue(self.entered.wait(5))
		with ThreadPoolExecutor(max_workers=1) as pool:
			closing = pool.submit(context.unloads[0])
			try:
				self.assertTrue(sampler._stop.wait(5))
				acquired = limits._OWNERS_LOCK.acquire(timeout=2)
				if acquired:
					limits._OWNERS_LOCK.release()
				self.assertTrue(acquired, "the owners lock is held while the sampler thread is joined")
				# The closed owner still fences late starts while its sampler finishes the tick.
				self.assertIsNone(limits.start_limits_sampler(self.store))
			finally:
				self.release.set()
				closing.result(timeout=10)
		self.assertFalse(sampler._thread.is_alive())

	def test_a_re_registration_starts_a_fresh_sampler_while_the_old_one_finishes_its_tick(self):
		self.register()
		old = limits.start_limits_sampler(self.store)
		self.assertTrue(self.entered.wait(5))
		with ThreadPoolExecutor(max_workers=2) as pool:
			registering = pool.submit(self.register)
			try:
				self.assertTrue(old._stop.wait(5))
				new = pool.submit(limits.start_limits_sampler, self.store).result(timeout=2)
			finally:
				self.release.set()
				registering.result(timeout=10)
		self.assertIsNot(new, old)
		self.assertTrue(new.is_running())
		self.assertFalse(old._thread.is_alive())
		# The old sampler's clean-up removed only its own registry entry.
		self.assertIs(limits._REGISTRY.get(self.key), new)


if __name__ == "__main__":
	unittest.main()
