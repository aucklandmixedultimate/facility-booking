// Guard for the local `npm run deploy` path.
//
// `gh-pages -d dist` force-publishes whatever is in dist/, overwriting whatever the
// Deploy workflow last published. A local build with no Supabase credentials still
// succeeds — Vite just inlines `undefined` — so the resulting bundle silently ships
// with `supabase === null`, which makes "Sign in with Google" a no-op and locks
// everyone out of the live site.
//
// The normal deploy path is CI: pushing to main runs .github/workflows/deploy.yml,
// which injects the credentials from repo secrets. This check exists so a local
// deploy fails loudly rather than quietly clobbering that with a broken build.
import { loadEnv } from "vite";

// loadEnv reads .env / .env.production / .env.local as well as process.env, so this
// matches exactly what `vite build` would inline.
const env = loadEnv("production", process.cwd(), "");
const missing = ["VITE_SUPABASE_URL", "VITE_SUPABASE_ANON"].filter((k) => !env[k]);

if (missing.length) {
  console.error(`
✗ Refusing to deploy: missing ${missing.join(" and ")}.

  Building without these inlines \`undefined\` as the Supabase credentials. The app
  still builds and deploys, but sign-in silently stops working for everyone.

  Deploys normally happen in CI — push to main and .github/workflows/deploy.yml
  publishes with the credentials from repo secrets. Prefer that.

  To deploy from here anyway, put the values in a local .env first (see .env.example).
`);
  process.exit(1);
}
