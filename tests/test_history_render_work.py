"""The history chart builds each model and provider bucket once, and the cache copies payloads outside its process-wide lock."""

import copy
import random
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from test_backend import backend
from test_usage_history import Fixture, linear_price


history = backend.usage_history


def reference_render(days, tz, now, buckets, window_end, series, missing):
	"""_render as it was before buckets were constructed only on insertion."""
	width = len(buckets)
	models = {}
	providers = {}
	fields = ("tokens", *history.TOKEN_CLASSES, "reasoning", "user_messages")
	lengths = [end - begin for begin, end in zip(buckets, [*buckets[1:], window_end])]

	def empty(key, label, provider, model):
		return {"key": key, "label": label, "provider": provider, "model": model, **{name: [0] * width for name in fields}, "cost_usd": [0.0] * width, "agents": [0.0] * width}

	for (provider, model), data in series.items():
		arrays = {name: history._round_preserving_sum([max(0.0, value) for value in data.values[name]]) for name in (*history.TOKEN_CLASSES, "reasoning")}
		arrays["tokens"] = [sum(arrays[name][index] for name in history.TOKEN_CLASSES) for index in range(width)]
		cost = [max(0.0, value) for value in data.values["cost_usd"]]
		users = list(data.user_messages)
		agents = [seconds / length for seconds, length in zip(data.agent_seconds, lengths)]
		if not any(arrays["tokens"]) and not any(users) and not any(round(value, 6) for value in cost) and not any(agents):
			continue
		label = provider or "unknown"
		entry = {**arrays, "cost_usd": cost, "user_messages": users, "agents": agents}
		model_bucket = models.setdefault(model, empty(model, model, label, model))
		if model_bucket["provider"] != label:
			model_bucket["provider"] = None
		for bucket in (model_bucket, providers.setdefault(label, empty(label, label, label, None))):
			for name in fields:
				bucket[name] = [left + right for left, right in zip(bucket[name], entry[name])]
			bucket["cost_usd"] = [left + right for left, right in zip(bucket["cost_usd"], cost)]
			bucket["agents"] = [left + right for left, right in zip(bucket["agents"], agents)]
	by_model = list(models.values())
	by_provider = list(providers.values())
	for entry in (*by_model, *by_provider):
		entry["cost_usd"] = [round(value, 6) for value in entry["cost_usd"]]
		entry["agents"] = [round(value, 6) for value in entry["agents"]]

	def order(entry):
		return (-sum(entry["tokens"]), entry["key"])

	by_model.sort(key=order)
	by_provider.sort(key=order)
	return {
		"generated_at": now,
		"days": days,
		"tz": tz,
		"resolution": f"{history.BUCKET_MINUTES[days]}m",
		"bucket_minutes": history.BUCKET_MINUTES[days],
		"buckets": [int(round(value)) for value in buckets],
		"window_end": int(round(window_end)),
		"by_provider": by_provider,
		"by_model": by_model,
		"totals": {
			"tokens": sum(sum(entry["tokens"]) for entry in by_provider),
			"cost_usd": round(sum(sum(entry["cost_usd"]) for entry in by_provider), 6),
			"user_messages": sum(sum(entry["user_messages"]) for entry in by_provider),
		},
		"pricing_missing": sorted(missing),
		"approximate": True,
	}


def generated_series(rng, width):
	result = {}
	for _ in range(rng.randint(0, 12)):
		data = history._Series(width)
		if rng.random() < .85:
			for name in data.values:
				data.values[name] = [rng.choice((0.0, 0.0, 0.4, 1.5, 7.25, 1000.5, -2.0)) for _ in range(width)]
			data.user_messages = [rng.choice((0, 0, 1, 3)) for _ in range(width)]
			data.agent_seconds = [rng.choice((0.0, 0.0, 0.1, 900.0, 3600.0, 7200.5)) for _ in range(width)]
		result[(rng.choice(("openai", "anthropic", "", None)), rng.choice(("m1", "m2", "m3", "m4")))] = data
	return result


def render(series, width):
	return history._render(7, "UTC", 1800000000.0, [1800000000.0 + 3600.0 * index for index in range(width)], 1800000000.0 + 3600.0 * width, series, {"x"})


class RenderBuckets(unittest.TestCase):
	def test_each_bucket_is_built_once(self):
		rng = random.Random(7)
		width = 24
		series = {}
		for provider in ("openai", "anthropic", "zai"):
			for model in ("m1", "m2", "m3", "m4", "m5"):
				data = history._Series(width)
				data.values["input"] = [rng.choice((1.0, 2.0)) for _ in range(width)]
				series[(provider, model)] = data
		built = []
		def profiler(frame, event, arg):
			if event == "call" and frame.f_code.co_name == "empty" and frame.f_code.co_filename.endswith("usage_history.py"):
				built.append(frame.f_locals["key"])
		sys.setprofile(profiler)
		try:
			payload = render(series, width)
		finally:
			sys.setprofile(None)
		self.assertEqual(sorted(built), sorted(["m1", "m2", "m3", "m4", "m5", "openai", "anthropic", "zai"]))
		self.assertEqual(len(payload["by_model"]) + len(payload["by_provider"]), 8)

	def test_generated_series_render_as_the_reference_does(self):
		for seed in range(80):
			rng = random.Random(seed)
			width = rng.choice((1, 3, 24))
			series = generated_series(rng, width)
			with self.subTest(seed=seed):
				expected = reference_render(7, "UTC", 1800000000.0, [1800000000.0 + 3600.0 * index for index in range(width)], 1800000000.0 + 3600.0 * width, series, {"x"})
				self.assertEqual(render(series, width), expected)


class CacheCopies(unittest.TestCase):
	def setUp(self):
		history.clear_cache()
		self.addCleanup(history.clear_cache)
		self.temp = tempfile.TemporaryDirectory(prefix="t3-history-cache-")
		self.addCleanup(self.temp.cleanup)
		self.db = Fixture(self.temp.name)
		self.now = 1800000000.0
		self.db.session("s1")
		self.db.message("s1", "assistant", self.now - 3600, "x")
		self.db.usage("s1", "m", "p", self.now - 3600, self.now - 3600, calls=1, input=10)

	def payload(self, now):
		return history.history_payload(self.db.path, days=7, tz="UTC", now=now, pricing=linear_price)

	def test_payloads_are_copied_outside_the_cache_lock_and_stay_independent(self):
		held = []
		deepcopy = copy.deepcopy
		def recording(value):
			held.append(history._cache_lock.locked())
			return deepcopy(value)
		with patch.object(history, "copy", SimpleNamespace(deepcopy=recording)):
			first = self.payload(self.now)
			hit = self.payload(self.now + 60)
		# One copy is published on the miss, one handed out on the hit; neither while every other request waits.
		self.assertEqual(held, [False, False])
		self.assertEqual((hit["generated_at"], hit["by_model"]), (self.now + 60, first["by_model"]))
		first["by_model"][0]["input"][:] = [-1] * len(first["buckets"])
		hit["by_model"][0]["input"][:] = [-2] * len(hit["buckets"])
		again = self.payload(self.now + 120)
		self.assertEqual(sum(again["by_model"][0]["input"]), 10)


if __name__ == "__main__":
	unittest.main()
