"""Agent-side activity/completion hooks; metadata routes live in dashboard/plugin_api.py."""


def register(ctx):
	"""Restore on real activity and observe success, without session history writes."""
	from .completion_hooks import register_completion_hooks
	from .shared_modules import load_limits_module

	register_completion_hooks(ctx)
	load_limits_module().register_limits_sampler(ctx)
