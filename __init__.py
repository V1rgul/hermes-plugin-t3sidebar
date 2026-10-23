"""Agent-side completion observers; metadata routes live in dashboard/plugin_api.py."""


def register(ctx):
	"""Observe native turn success without a client or session history writes."""
	from .completion_hooks import register_completion_hooks

	register_completion_hooks(ctx)
