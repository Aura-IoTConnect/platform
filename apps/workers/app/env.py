"""Loads apps/workers/.env into os.environ as a side effect of being imported.

Import this module FIRST in an entry point (before any other `app.*` import):
modules such as app/db.py and app/mqtt_client.py read os.environ at import
time, so the .env file has to be loaded before they run. It lives in its own
module — rather than a `load_dotenv()` call sitting between import statements
in each entry point — so the imports in main.py and the scripts stay a plain,
lint-clean block at the top of the file."""

from dotenv import load_dotenv

load_dotenv()
