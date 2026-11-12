"""Gate decisions of tests/perf/backend_bench.py, checked on hand-made results so that no fixture is built and nothing is timed."""

import importlib.util
import io
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import patch

PATH = Path(__file__).resolve().parent / "perf" / "backend_bench.py"
SPEC = importlib.util.spec_from_file_location("hermes_t3sidebar_backend_bench_gates", PATH)
assert SPEC is not None and SPEC.loader is not None
bench = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = bench
SPEC.loader.exec_module(bench)

NAMES = ["metadata_state", "native_sessions_plain", "usage_history_7d_cold", "usage_history_7d_cached", "usage_limits_168h"]


def measured(statements=10, median=1.0):
	return {"statements": statements, "median_ms": median, "p95_ms": median, "min_ms": median, "samples_ms": [median], "statement_kinds": {}}


def gate(results, baseline=None, allow_output_change=False, budgets=None):
	budgets = budgets if budgets is not None else {name: {"statements": 10, "median_ms": 50.0} for name in results}
	return bench.apply_gates(results, budgets, "candidate", baseline, 1.25, 2.0, True, allow_output_change)


class ScenarioSelection(unittest.TestCase):
	def test_every_scenario_without_a_selector(self):
		self.assertEqual(bench.select_scenarios(NAMES, []), NAMES)

	def test_substrings_select_matching_scenarios(self):
		self.assertEqual(bench.select_scenarios(NAMES, ["usage_history", "metadata"]), ["metadata_state", "usage_history_7d_cold", "usage_history_7d_cached"])

	def test_a_selector_matching_nothing_is_refused(self):
		with self.assertRaisesRegex(ValueError, r"--only usage_histroy matches no scenario"):
			bench.select_scenarios(NAMES, ["usage_histroy"])
		with self.assertRaisesRegex(ValueError, r"--only bogus matches no scenario"):
			bench.select_scenarios(NAMES, ["7d", "bogus"])

	def test_a_blank_selector_is_refused(self):
		for token in ("", "  "):
			with self.assertRaisesRegex(ValueError, "non-blank"):
				bench.select_scenarios(NAMES, [token])


class Gates(unittest.TestCase):
	def test_an_empty_result_set_fails(self):
		self.assertEqual(gate({}), ["no scenario was measured"])

	def test_a_skipped_candidate_scenario_fails(self):
		results = {"usage_limits_168h": {"impls": {"candidate": {"skipped": "module or seam absent in this revision"}}}}
		self.assertEqual(gate(results), ["usage_limits_168h: the candidate did not run it (module or seam absent in this revision)"])
		self.assertEqual(results["usage_limits_168h"]["status"], ["SKIPPED"])

	def test_a_skipped_baseline_is_reported_without_failing(self):
		results = {"usage_limits_168h": {"impls": {"baseline": {"skipped": "AttributeError: no limits"}, "candidate": measured()}}}
		self.assertEqual(gate(results, baseline="baseline"), [])
		self.assertEqual(bench.baseline_skips(results, "baseline"), ["usage_limits_168h: baseline skipped (AttributeError: no limits)"])
		self.assertEqual(bench.baseline_skips(results, None), [])

	def test_an_output_difference_fails_unless_allowed(self):
		def results():
			return {"metadata_state": {"impls": {"baseline": measured(), "candidate": measured()}, "same_output": False, "output_difference": "$.sessions: 2 items in baseline, 1 in candidate"}}
		failures = gate(results(), baseline="baseline")
		self.assertEqual(failures, ["metadata_state: output differs from the baseline at $.sessions: 2 items in baseline, 1 in candidate (pass --allow-output-change if the change is intended)"])
		self.assertEqual(gate(results(), baseline="baseline", allow_output_change=True), [])
		same = {"metadata_state": {"impls": {"baseline": measured(), "candidate": measured()}, "same_output": True}}
		self.assertEqual(gate(same, baseline="baseline"), [])


class OutputDifference(unittest.TestCase):
	def test_identical_outputs_have_no_difference(self):
		self.assertIsNone(bench.output_difference('{"a": [1, {"b": "x"}]}', '{"a": [1, {"b": "x"}]}'))

	def test_the_first_differing_path_is_named(self):
		self.assertEqual(bench.output_difference('{"a": [1, {"b": "x"}]}', '{"a": [1, {"b": "y"}]}'), "$.a[1].b: 'x' in baseline, 'y' in candidate")
		self.assertEqual(bench.output_difference('{"rows": [1, 2]}', '{"rows": [1]}'), "$.rows: 2 items in baseline, 1 in candidate")
		self.assertEqual(bench.output_difference('{"a": 1, "b": 2}', '{"a": 1}'), "$.b: only in baseline")
		self.assertEqual(bench.output_difference('{"a": 1}', '{"a": 1, "c": 3}'), "$.c: only in candidate")
		self.assertEqual(bench.output_difference('{"a": 1}', '{"a": 1.0}'), "$.a: int in baseline, float in candidate")


class RunScenarios(unittest.TestCase):
	"""run_scenarios on stand-in scenarios: what it records is what the gates above decide on."""

	def run_with(self, listed, impls, only=()):
		with patch.object(bench, "scenarios", lambda fx: listed), patch.object(bench.sys, "stderr", io.StringIO()):
			return bench.run_scenarios(None, impls, 0, 1, list(only))

	def test_a_candidate_missing_a_seam_becomes_a_gate_failure(self):
		baseline, candidate = SimpleNamespace(label="baseline", seam=True), SimpleNamespace(label="candidate", seam=False)
		listed = [("seam_read", "needs a seam", lambda impl: impl.seam, lambda impl: lambda: {"rows": [1]}, None)]
		results = self.run_with(listed, [baseline, candidate])
		self.assertEqual(results["seam_read"]["impls"]["candidate"], {"skipped": "module or seam absent in this revision"})
		self.assertEqual(gate(results, baseline="baseline"), ["seam_read: the candidate did not run it (module or seam absent in this revision)"])

	def test_differing_outputs_are_recorded_with_their_location(self):
		baseline, candidate = SimpleNamespace(label="baseline", rows=[1, 2]), SimpleNamespace(label="candidate", rows=[1])
		listed = [("listing", "rows", lambda impl: True, lambda impl: lambda: {"generated_at": impl.label, "rows": impl.rows}, None)]
		results = self.run_with(listed, [baseline, candidate])
		self.assertIs(results["listing"]["same_output"], False)
		self.assertEqual(results["listing"]["output_difference"], "$.rows: 2 items in baseline, 1 in candidate")
		self.assertEqual(len(gate(results, baseline="baseline")), 1)

	def test_only_selected_scenarios_run(self):
		calls = []
		listed = [(name, name, lambda impl: True, lambda impl, name=name: lambda: calls.append(name) or {}, None) for name in ("alpha_read", "beta_read")]
		results = self.run_with(listed, [SimpleNamespace(label="candidate")], only=["beta"])
		self.assertEqual(list(results), ["beta_read"])
		self.assertEqual(set(calls), {"beta_read"})


if __name__ == "__main__":
	unittest.main()
