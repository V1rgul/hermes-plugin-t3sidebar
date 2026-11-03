"""Share plugin-owned sampler state across agent-package and file-based API imports."""
from hashlib import sha256
from importlib import import_module
from importlib.machinery import ModuleSpec
from importlib.util import module_from_spec
from pathlib import Path
import sys


def load_limits_module():
	# Hermes assigns unrelated package/API names. A path-owned namespace keeps their lifecycle state together without importing the HTTP layer in agent workers.
	root = Path(__file__).resolve().parent
	name = "_hermes_t3sidebar_shared_" + sha256(str(root).encode("utf-8")).hexdigest()
	package = module_from_spec(ModuleSpec(name, loader=None, is_package=True))
	package.__path__ = [str(root)]
	sys.modules.setdefault(name, package)
	# Normal import locking prevents concurrent registration and HTTP loads from seeing a half-initialized sampler module.
	return import_module(name + ".usage_limits")
