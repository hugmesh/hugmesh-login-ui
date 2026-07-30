/**
 * Native-federation REMOTE entrypoint for hugmesh-login-ui.
 *
 * `initFederation()` registers this remote with the native-federation runtime
 * (no manifest argument — remotes are self-describing; the host's
 * `initFederation(manifest)` handles discovery). Once federation wiring is
 * complete, `./bootstrap` bootstraps the standalone Angular dev-shell
 * (AppComponent + LOGIN_ROUTES). In production the host federates
 * `./routes` (LOGIN_ROUTES) directly without bootstrapping the shell.
 *
 * Errors are logged but NOT rethrown so a misconfigured federation init
 * does not hard-fail the dev shell.
 */
import { initFederation } from '@angular-architects/native-federation';

initFederation()
  .catch(err => console.error(err))
  .then(_ => import('./bootstrap'))
  .catch(err => console.error(err));
