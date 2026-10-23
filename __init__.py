"""Agent-side activity/completion hooks; metadata routes live in dashboard/plugin_api.py."""


def register(ctx):
	"""Restore on real activity and observe success, without session history writes."""
	from .completion_hooks import register_completion_hooks

	register_completion_hooks(ctx)
