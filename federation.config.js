// REMOTE config for the hugmesh-login-ui native-federation bundle. This repo
// is a remote (the host hugmesh.net consumes it via loadRemoteModule),
// exposing the login/registration routes under the remote name "login".
//
// The shared-deps surface (singletons, strictVersion, requiredVersion: 'auto')
// + the RxJS skip list live in ./federation-base.js so the federation contract
// lands in ONE file shared with the host and every sibling remote — a drift
// (e.g. one bundle sharing a different RxJS subpath) can't quietly produce a
// "shared is not a function" runtime failure. Mirrors hugmesh.games/frontend.
const { hugmeshRemote } = require('./federation-base');

module.exports = hugmeshRemote({
  name: 'login',
  exposes: {
    './routes': './src/app/login.routes.ts',
  },
});
