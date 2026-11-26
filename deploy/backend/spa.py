"""Static files with a single-page-app fallback and sane cache headers.

/ and /app are routes of the React app, not files. Anything under /api that
reaches this handler is a real 404 and must stay one. Hashed files under
/assets are immutable, so browsers keep them for a year; index.html is always
revalidated so a new deploy is picked up at once.
"""
from starlette.exceptions import HTTPException
from starlette.staticfiles import StaticFiles


class SPAStaticFiles(StaticFiles):
    async def get_response(self, path, scope):
        try:
            resp = await super().get_response(path, scope)
        except HTTPException as exc:
            if exc.status_code == 404 and not path.startswith("api/") and "." not in path.rsplit("/", 1)[-1]:
                resp = await super().get_response("index.html", scope)
                resp.headers["Cache-Control"] = "no-cache"
                return resp
            raise
        if path.startswith("assets/"):
            resp.headers["Cache-Control"] = "public, max-age=31536000, immutable"
        elif path in ("", ".", "index.html") or path.endswith(".html"):
            resp.headers["Cache-Control"] = "no-cache"
        else:
            resp.headers["Cache-Control"] = "public, max-age=3600"
        return resp
