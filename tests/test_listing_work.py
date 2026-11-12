"""Listing enrichment does its per-card work in time that does not grow with unrelated parts of the request."""

from pathlib import Path
import random
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from test_backend import backend


class Id(str):
	"""A session id that counts the equality tests made against it, the unit of work of a list membership scan."""

	comparisons = 0

	def __eq__(self, other):
		Id.comparisons += 1
		return str.__eq__(self, other)

	__hash__ = str.__hash__


def compressed_card_comparisons(children):
	"""Enrich one card of a 100-segment compression chain whose first segment spawned ``children`` subagents; return the card and the id comparisons made."""
	chain = [Id(f"segment-{index}") for index in range(100)]
	row = {"id": Id("tip"), "_lineage_ids": chain, "title": "t", "source": "cli"}
	segments = {sid: {"id": sid, "input_tokens": 1, "output_tokens": 1} for sid in ["tip", *map(str, chain)]}
	segments["tip"]["model_config"] = {"provider": "fixture-provider"}
	# One subagent's own compression continuation is also a chain segment and must count once.
	subagents = {"segment-0": {**{f"child-{index}": (2, 3) for index in range(children)}, "segment-5": (1, 1)}}
	with patch.object(backend, "stored_rows", return_value=segments), \
			patch.object(backend, "card_subagent_usage", return_value=subagents), \
			patch.object(backend, "card_projects", return_value=[]):
		Id.comparisons = 0
		(card,) = backend.card_rows(object(), [row])
		return card, Id.comparisons


class LineageMembership(unittest.TestCase):
	def test_child_membership_work_does_not_grow_with_the_number_of_children(self):
		few, few_comparisons = compressed_card_comparisons(50)
		many, many_comparisons = compressed_card_comparisons(100)
		self.assertEqual((few["input_tokens"], few["output_tokens"]), (101 + 50 * 2, 101 + 50 * 3))
		self.assertEqual((many["input_tokens"], many["output_tokens"]), (101 + 100 * 2, 101 + 100 * 3))
		self.assertEqual(many_comparisons, few_comparisons)


class CountedProject:
	"""A catalog project that counts how often its folders are read, the unit of work of flattening the catalog."""

	reads = 0

	def __init__(self, pid, *folders):
		self.id, self.name, self.icon, self.color = pid, f"Project {pid}", None, None
		self._folders = [SimpleNamespace(path=path) for path in folders]

	@property
	def folders(self):
		CountedProject.reads += 1
		return self._folders


def reference_card_project(cwd, projects):
	"""card_project as it was before folder owners were prepared once per request."""
	if not isinstance(cwd, str) or not cwd.strip():
		return {"id": "__no_project__", "name": "Home", "icon": None, "color": None, "cwd": None, "is_home": True}
	from hermes_cli.projects_db import _normalize_path
	target = _normalize_path(cwd)
	owners = [(folder.path, project) for project in projects for folder in project.folders
		if target == folder.path or any(target.startswith(folder.path.rstrip("/\\") + separator) for separator in (backend.os.sep, "/"))]
	if owners:
		folder, project = max(owners, key=lambda owner: len(owner[0]))
		return {"id": project.id, "name": project.name, "icon": project.icon, "color": project.color, "cwd": folder}
	return {"id": target, "name": Path(target).name or target, "icon": None, "color": None, "cwd": target}


class ProjectOwners(unittest.TestCase):
	def setUp(self):
		CountedProject.reads = 0
		self.catalog = [CountedProject("outer", "/work/repo", "/second"), CountedProject("inner", "/work/repo/nested"), CountedProject("other", "/elsewhere")]

	def test_a_listing_flattens_the_catalog_once_whatever_its_number_of_cards(self):
		rows = [{"id": f"s{index}", "cwd": f"/work/repo/nested/{index}" if index % 2 else "/second/x", "source": "cli",
			"model_config": {"provider": "fixture-provider"}} for index in range(40)]
		with patch.object(backend, "card_subagent_usage", return_value={}), patch.object(backend, "card_projects", return_value=self.catalog):
			cards = backend.card_rows(object(), rows)
		self.assertEqual(CountedProject.reads, len(self.catalog))
		self.assertEqual({card["project"]["id"] for card in cards}, {"inner", "outer"})

	def test_a_draft_sync_flattens_the_catalog_once_whatever_its_number_of_drafts(self):
		drafts = [{"session_id": f"d{index}", "text": "kept", "cwd": f"/work/repo/{index}"} for index in range(40)]
		db = SimpleNamespace(close=lambda: None)
		with patch.object(backend, "open_session_db", return_value=db), patch.object(backend, "card_projects", return_value=self.catalog):
			value = backend.native_drafts("default", drafts)
		self.assertEqual(CountedProject.reads, len(self.catalog))
		self.assertEqual({draft["project"]["id"] for draft in value}, {"outer"})

	def test_generated_catalogs_give_the_projects_the_reference_gives(self):
		segments = ["work", "repo", "nested", "re", "x"]
		for seed in range(60):
			rng = random.Random(seed)
			path = lambda: "/" + "/".join(rng.choice(segments) for _ in range(rng.randint(1, 4)))
			catalog = [SimpleNamespace(id=f"p{index}", name=f"P{index}", icon=None, color=None,
				folders=[SimpleNamespace(path=path() + rng.choice(("", "", "/"))) for _ in range(rng.randint(0, 3))]) for index in range(rng.randint(0, 5))]
			owners = backend.project_owners(catalog)
			for _ in range(20):
				cwd = rng.choice((path(), path() + "/", " " + path(), "", None))
				with self.subTest(seed=seed, cwd=cwd):
					expected = reference_card_project(cwd, catalog)
					self.assertEqual(backend.card_project(cwd, catalog), expected)
					self.assertEqual(backend.card_project(cwd, catalog, owners), expected)


if __name__ == "__main__":
	unittest.main()
