// Load .env for local development and VPS runs.
// In CI, environment variables are injected via secrets — dotenv silently no-ops
// when the file doesn't exist, so this is safe to commit.
import { config } from "dotenv";
config({ path: new URL("../.env", import.meta.url).pathname });
