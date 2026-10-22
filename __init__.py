"""Session Flow's agent entry point; metadata routes live in dashboard/plugin_api.py."""


def register(ctx):
	"""No tools, hooks, session history mutations, or background jobs."""
	return None
