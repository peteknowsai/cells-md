// cells.md front door. www.cells.md is canonical; every other host
// (apex cells.md, legacy brief.cells.md) 301-redirects there, path
// and query preserved. run_worker_first is set in wrangler.toml so
// this handler sees every request before static assets are served.

interface Env {
  ASSETS: { fetch: (request: Request) => Promise<Response> };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.hostname !== "www.cells.md") {
      url.hostname = "www.cells.md";
      url.protocol = "https:";
      url.port = "";
      return Response.redirect(url.toString(), 301);
    }
    return env.ASSETS.fetch(request);
  },
};
