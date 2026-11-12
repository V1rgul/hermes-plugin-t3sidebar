"""Listing enrichment does its per-card work in time that does not grow with unrelated parts of the request."""

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


if __name__ == "__main__":
	unittest.main()
