"""Static files with a single-page-app fallback.

/ and /app are routes of the React app, not files. Anything under /api that
reaches this handler is a real 404 and must stay one.
"""
from starlette.exceptions import HTTPException
from starlette.staticfiles import StaticFiles


class SPAStaticFiles(StaticFiles):
    async def get_response(self, path, scope):
        try:
            return await super().get_response(path, scope)
        except HTTPException as exc:
            if exc.status_code == 404 and not path.startswith("api/") and "." not in path.rsplit("/", 1)[-1]:
                return await super().get_response("index.html", scope)
            raise
