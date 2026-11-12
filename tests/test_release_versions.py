"""The two manifests a release edits by hand carry the same version."""

import json
from pathlib import Path
import unittest

import yaml


ROOT = Path(__file__).resolve().parents[1]


def manifest_versions(root):
	plugin = yaml.safe_load((root / "plugin.yaml").read_text())
	dashboard = json.loads((root / "dashboard/manifest.json").read_text())
	return plugin.get("version"), dashboard.get("version")


class ReleaseVersions(unittest.TestCase):
	def test_plugin_and_dashboard_manifests_carry_the_same_version(self):
		plugin, dashboard = manifest_versions(ROOT)
		self.assertIsInstance(plugin, str)
		self.assertRegex(plugin, r"^\d+\.\d+\.\d+")
		self.assertEqual(plugin, dashboard, "plugin.yaml and dashboard/manifest.json must be released with the same version")


if __name__ == "__main__":
	unittest.main()
